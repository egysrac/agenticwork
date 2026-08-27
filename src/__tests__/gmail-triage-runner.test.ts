import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

// TRIAGE826 test suite. Mocks the global fetch so no real Gmail / Google
// Calendar / Anthropic API call is made. The OAuth credential file is
// swapped for a fake (non-expired) one for the duration of the suite, then
// restored verbatim -- a failed test cannot leave the real credential file
// in a bad state.
//
// The test order matters: helpers (validateInvoiceData, isAndiSender) run
// before the integration tests, which need the mocked fetch + fake creds.

import {
  // OAuth helpers (mocked at the fetch layer)
  _accessToken,
  _hasScope,
  _invalidateOAuthCache,
  _invalidateSmtpUsernameCache,
  _listIds,
  _batchModify,
  _httpRequest,
  // Safety net
  protectCategoryPrimary,
  // Bulk mutations
  bulkModifyByQuery,
  markReadByQuery,
  // Andi gate
  isAndiSender,
  andIEmailReply,
  // LLM extract
  extractInvoiceData,
  validateInvoiceData,
  type InvoiceData,
} from '../gmail-api.js'
import { runGmailCleanupNow } from '../web/gmail-cleanup-runner.js'
import { STORE_DIR } from '../config.js'

// === OAuth credential file swapping ===

const OAUTH_PATH = join(STORE_DIR, '.google-oauth.json')
const BACKUP_PATH = OAUTH_PATH + '.test-backup'
let oauthBackupContent: string | null = null

const FAKE_OAUTH = {
  client_id: 'fake-client-id.apps.googleusercontent.com',
  client_secret: 'fake-client-secret',
  token_uri: 'https://oauth2.googleapis.com/token',
  refresh_token: 'fake-refresh-token',
  scopes: [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ],
  access_token: 'fake-access-token-not-expired',
  expiry_date: Date.now() + 3600 * 1000, // 1h in the future
  expires_in: 3600,
  obtained_at: Math.floor(Date.now() / 1000),
}

beforeAll(() => {
  if (existsSync(OAUTH_PATH)) {
    oauthBackupContent = readFileSync(OAUTH_PATH, 'utf-8')
    copyFileSync(OAUTH_PATH, BACKUP_PATH)
  }
  writeFileSync(OAUTH_PATH, JSON.stringify(FAKE_OAUTH, null, 2), { mode: 0o600 })
  _invalidateOAuthCache()
})

afterAll(() => {
  if (oauthBackupContent !== null) {
    writeFileSync(OAUTH_PATH, oauthBackupContent, { mode: 0o600 })
  } else if (existsSync(BACKUP_PATH)) {
    copyFileSync(BACKUP_PATH, OAUTH_PATH)
  }
  _invalidateOAuthCache()
  _invalidateSmtpUsernameCache()
})

// === fetch mocking ===

type FetchCall = { url: string; method?: string; body?: string }
const recordedCalls: FetchCall[] = []
let nextResponse: { status: number; body: string } | ((req: FetchCall) => { status: number; body: string }) = { status: 200, body: '{}' }

function setNextResponse(resp: { status: number; body: string } | ((req: FetchCall) => { status: number; body: string })): void {
  nextResponse = resp
}

function makeFetchSpy(): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url
    const method = init?.method ?? 'GET'
    const body = init?.body
    const call: FetchCall = { url, method, body: typeof body === 'string' ? body : undefined }
    recordedCalls.push(call)
    const r = typeof nextResponse === 'function' ? nextResponse(call) : nextResponse
    // Response constructor rejects 204/205/304 with a body. Gmail's
    // batchModify returns 204 in production; emulate by routing those
    // statuses to a 200 with an empty body for the mocked fetch.
    const status = (r.status === 204 || r.status === 205 || r.status === 304) ? 200 : r.status
    const bodyText = (status === 200 || status === 201) ? r.body : ''
    return new Response(bodyText, {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

const originalFetch = globalThis.fetch
beforeEach(() => {
  recordedCalls.length = 0
  globalThis.fetch = makeFetchSpy()
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

// === Pure-function tests (no fetch) ===

describe('validateInvoiceData', () => {
  it('accepts a well-formed HUF invoice', () => {
    const r = validateInvoiceData(
      { date: '2026-09-15', amount: 12990, currency: 'HUF', description: 'Yettel havi számla' },
      'msg-1',
    )
    expect(r).toEqual({
      date: '2026-09-15',
      amount: 12990,
      currency: 'HUF',
      description: 'Yettel havi számla',
      source_email_id: 'msg-1',
    })
  })

  it('accepts EUR and USD', () => {
    expect(validateInvoiceData({ date: '2026-09-01', amount: 42, currency: 'EUR', description: 'Premium' }, 'm')?.currency).toBe('EUR')
    expect(validateInvoiceData({ date: '2026-09-01', amount: 42, currency: 'USD', description: 'Premium' }, 'm')?.currency).toBe('USD')
  })

  it('lowercases currency and validates the result', () => {
    expect(validateInvoiceData({ date: '2026-09-01', amount: 42, currency: 'eur', description: 'X' }, 'm')?.currency).toBe('EUR')
  })

  it('rejects a non-ISO date', () => {
    expect(validateInvoiceData({ date: '2026/09/01', amount: 1, currency: 'HUF', description: 'X' }, 'm')).toBeNull()
    expect(validateInvoiceData({ date: 'Sep 1 2026', amount: 1, currency: 'HUF', description: 'X' }, 'm')).toBeNull()
  })

  it('rejects an invalid calendar date', () => {
    expect(validateInvoiceData({ date: '2026-02-31', amount: 1, currency: 'HUF', description: 'X' }, 'm')).toBeNull()
  })

  it('rejects a non-positive or non-finite amount', () => {
    expect(validateInvoiceData({ date: '2026-09-01', amount: 0, currency: 'HUF', description: 'X' }, 'm')).toBeNull()
    expect(validateInvoiceData({ date: '2026-09-01', amount: -1, currency: 'HUF', description: 'X' }, 'm')).toBeNull()
    expect(validateInvoiceData({ date: '2026-09-01', amount: Number.NaN, currency: 'HUF', description: 'X' }, 'm')).toBeNull()
  })

  it('rejects an unknown currency', () => {
    expect(validateInvoiceData({ date: '2026-09-01', amount: 1, currency: 'GBP', description: 'X' }, 'm')).toBeNull()
  })

  it('rejects a missing or empty description', () => {
    expect(validateInvoiceData({ date: '2026-09-01', amount: 1, currency: 'HUF', description: '' }, 'm')).toBeNull()
    expect(validateInvoiceData({ date: '2026-09-01', amount: 1, currency: 'HUF' }, 'm')).toBeNull()
  })

  it('rejects non-object input', () => {
    expect(validateInvoiceData(null, 'm')).toBeNull()
    expect(validateInvoiceData('not-an-object', 'm')).toBeNull()
    expect(validateInvoiceData([], 'm')).toBeNull()
  })

  it('truncates a long description to 500 chars', () => {
    const long = 'x'.repeat(800)
    const r = validateInvoiceData({ date: '2026-09-01', amount: 1, currency: 'HUF', description: long }, 'm')
    expect(r?.description.length).toBe(500)
  })
})

describe('isAndiSender (exact-match gate)', () => {
  it('matches the bare Andi address', () => {
    expect(isAndiSender('zavada.andrea@gmail.com')).toBe(true)
  })

  it('matches a display-name envelope around the bare address', () => {
    expect(isAndiSender('Zavada Andrea <zavada.andrea@gmail.com>')).toBe(true)
    expect(isAndiSender('"Andi" <zavada.andrea@gmail.com>')).toBe(true)
    expect(isAndiSender('  zavada.andrea@gmail.com  ')).toBe(true)
  })

  it('is case-insensitive on the address', () => {
    expect(isAndiSender('ZAVADA.ANDREA@GMAIL.COM')).toBe(true)
    expect(isAndiSender('Andi <Zavada.Andrea@Gmail.Com>')).toBe(true)
  })

  // REGRESSION (2026-08-27 TRIAGE826): the original auto-reply name guess was
  // "Andini" -- fuzzy match would have leaked replies to a different person.
  // The gate is intentionally exact: "Andini" must NEVER match.
  it('REGRESSION: "Andini" does NOT match (exact-match only)', () => {
    expect(isAndiSender('Andini <zavada.andrea@gmail.com>')).toBe(true)  // display-name noise is fine; address is exact
    expect(isAndiSender('andini.zavada@gmail.com')).toBe(false)          // different address, no fuzzy match
    expect(isAndiSender('Andini <zavadaandrea@gmail.com>')).toBe(false)  // missing dot
    expect(isAndiSender('Andini <zavada.andrea@googlemail.com>')).toBe(false)
  })

  it('rejects an empty / missing sender', () => {
    expect(isAndiSender('')).toBe(false)
    expect(isAndiSender(undefined as unknown as string)).toBe(false)
  })

  it('rejects any other Gmail address', () => {
    expect(isAndiSender('someone.else@gmail.com')).toBe(false)
    expect(isAndiSender('alex@gmail.com')).toBe(false)
  })
})

describe('andIEmailReply gate (throws when fromEnvelope is not Andi)', () => {
  it('throws when the envelope is not Andi -- without making any SMTP call', async () => {
    await expect(andIEmailReply({ to: 'x@y', subject: 's', text: 't' }, 'mallory@gmail.com'))
      .rejects.toThrow(/refusing to reply to non-Andi sender/i)
  })

  it('throws when the envelope is empty', async () => {
    await expect(andIEmailReply({ to: 'x@y', subject: 's', text: 't' }, ''))
      .rejects.toThrow(/refusing to reply to non-Andi sender/i)
  })

  it('proves the gate runs BEFORE the SMTP socket -- no fetch / SMTP call observed on rejection', async () => {
    recordedCalls.length = 0
    await expect(andIEmailReply({ to: 'x@y', subject: 's', text: 't' }, 'mallory@gmail.com'))
      .rejects.toThrow()
    // The gate must short-circuit; the only allowed call would be the openid
    // userinfo fetch that _ensureSmtpUsername would make. We assert none was
    // made -- the gate wins, SMTP never opens.
    expect(recordedCalls).toHaveLength(0)
  })
})

// === OAuth helpers (with mocked fetch) ===

describe('_hasScope', () => {
  it('returns true when the scope is in the stored scopes list', () => {
    expect(_hasScope('https://www.googleapis.com/auth/gmail.send')).toBe(true)
    expect(_hasScope('https://www.googleapis.com/auth/gmail.modify')).toBe(true)
    expect(_hasScope('https://www.googleapis.com/auth/calendar')).toBe(true)
  })
  it('returns false for an absent scope', () => {
    expect(_hasScope('https://www.googleapis.com/auth/drive')).toBe(false)
  })
})

describe('_accessToken / _httpRequest', () => {
  it('_accessToken returns the stored token when it is not expired', async () => {
    // The fake OAuth has expiry_date = now + 1h. The function should NOT
    // hit the token_uri refresh endpoint.
    recordedCalls.length = 0
    const token = await _accessToken()
    expect(token).toBe(FAKE_OAUTH.access_token)
    expect(recordedCalls).toHaveLength(0)
  })

  it('_httpRequest sends a GET with the supplied headers', async () => {
    setNextResponse({ status: 200, body: '{"ok":1}' })
    const r = await _httpRequest('https://example.test/foo', { headers: { 'X-Test': 'yes' } })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.data)).toEqual({ ok: 1 })
    expect(recordedCalls).toHaveLength(1)
    expect(recordedCalls[0].url).toBe('https://example.test/foo')
    expect(recordedCalls[0].method).toBe('GET')
    expect(recordedCalls[0].body).toBeUndefined()
  })

  it('_httpRequest POSTs a JSON body with Content-Type application/json', async () => {
    setNextResponse({ status: 204, body: '' })
    const r = await _httpRequest('https://example.test/bar', { method: 'POST' }, { a: 1 })
    // Mock translates 204 (no-body) to 200 (empty-body) because Response ctor
    // rejects 204 with a body. The Gmail API in production returns 204 -- the
    // production code accepts both 204 and 200.
    expect([200, 204]).toContain(r.status)
    expect(recordedCalls[0].method).toBe('POST')
    expect(recordedCalls[0].body).toBe('{"a":1}')
  })
})

// === _listIds / _batchModify ===

describe('_listIds (paginated Gmail messages.list)', () => {
  it('returns the union of every page', async () => {
    let page = 0
    setNextResponse((req) => {
      const url = req.url
      if (url.includes('pageToken=p2')) {
        return { status: 200, body: JSON.stringify({ messages: [{ id: 'c' }, { id: 'd' }] }) }
      }
      if (url.includes('pageToken=p1')) {
        return { status: 200, body: JSON.stringify({ messages: [{ id: 'b' }], nextPageToken: 'p2' }) }
      }
      return { status: 200, body: JSON.stringify({ messages: [{ id: 'a' }], nextPageToken: 'p1' }) }
    })
    const ids = await _listIds('category:updates')
    expect(ids).toEqual(['a', 'b', 'c', 'd'])
  })

  it('returns an empty array when no messages match', async () => {
    setNextResponse({ status: 200, body: JSON.stringify({ messages: [] }) })
    expect(await _listIds('nothing-matches-this')).toEqual([])
  })

  it('throws on a non-200 response', async () => {
    setNextResponse({ status: 500, body: 'kaboom' })
    await expect(_listIds('q')).rejects.toThrow(/HTTP 500/)
  })

  it('retries once with a refreshed token on 401', async () => {
    let count401 = 0
    let count200 = 0
    setNextResponse((req) => {
      if (req.url.startsWith('https://oauth2.googleapis.com/token')) {
        return { status: 200, body: JSON.stringify({ access_token: 'refreshed-tok', expires_in: 3600 }) }
      }
      if (count401 === 0) {
        count401++
        return { status: 401, body: '{"error":"unauthorized"}' }
      }
      count200++
      return { status: 200, body: JSON.stringify({ messages: [{ id: 'after-refresh' }] }) }
    })
    const ids = await _listIds('q')
    expect(ids).toEqual(['after-refresh'])
    expect(count401).toBe(1)
    expect(count200).toBe(1)
    // Refresh must have been persisted (the fake write back uses the fake file).
    _invalidateOAuthCache()
  })
})

describe('_batchModify', () => {
  it('chunks >1000 ids into separate batchModify requests', async () => {
    setNextResponse({ status: 204, body: '' })
    const ids = Array.from({ length: 2500 }, (_, i) => `id-${i}`)
    await _batchModify(ids, ['TRASH'], ['INBOX'])
    const batchCalls = recordedCalls.filter(c => c.url.includes('batchModify'))
    expect(batchCalls.length).toBe(3) // 1000 + 1000 + 500
    const chunks = batchCalls.map(c => JSON.parse(c.body!).ids.length)
    expect(chunks).toEqual([1000, 1000, 500])
  })

  it('is a no-op on an empty id list', async () => {
    await _batchModify([], ['TRASH'])
    expect(recordedCalls).toHaveLength(0)
  })

  it('throws on non-204 (and non-200)', async () => {
    setNextResponse({ status: 400, body: 'bad' })
    await expect(_batchModify(['a'], ['TRASH'])).rejects.toThrow(/HTTP 400/)
  })
})

// === protectCategoryPrimary (mocked) ===

describe('protectCategoryPrimary', () => {
  function setLabelResponses(labelsById: Record<string, string[]>): void {
    setNextResponse((req) => {
      const m = req.url.match(/\/messages\/([^/?]+)/)
      if (!m) return { status: 200, body: '{}' }
      const id = decodeURIComponent(m[1])
      const labels = labelsById[id] ?? []
      return { status: 200, body: JSON.stringify({ labelIds: labels }) }
    })
  }

  it('drops ids whose labelIds include CATEGORY_PRIMARY', async () => {
    setLabelResponses({
      'a': ['INBOX', 'CATEGORY_PRIMARY'],
      'b': ['INBOX', 'CATEGORY_PROMOTIONS'],
      'c': ['INBOX'],
    })
    const safe = await protectCategoryPrimary(['a', 'b', 'c'])
    expect(safe).toEqual(['b', 'c'])
  })

  it('drops ids whose labelIds include CATEGORY_PERSONAL', async () => {
    setLabelResponses({
      'a': ['INBOX', 'CATEGORY_PERSONAL'],
      'b': ['INBOX'],
    })
    const safe = await protectCategoryPrimary(['a', 'b'])
    expect(safe).toEqual(['b'])
  })

  it('returns an empty array on empty input', async () => {
    expect(await protectCategoryPrimary([])).toEqual([])
  })

  it('fails open on a non-200 metadata fetch (id stays in the safe list)', async () => {
    setNextResponse({ status: 500, body: 'err' })
    const safe = await protectCategoryPrimary(['a', 'b'])
    // We never know the labels -> keep the id, let the caller handle the
    // post-batch error.
    expect(safe).toEqual(['a', 'b'])
  })

  it('accepts a custom primaryCategoryLabels set (test seam)', async () => {
    setLabelResponses({ 'a': ['INBOX', 'CATEGORY_SOCIAL'] })
    // Default behaviour: CATEGORY_SOCIAL is NOT protected.
    expect(await protectCategoryPrimary(['a'])).toEqual(['a'])
    // Custom behaviour: pass ['CATEGORY_SOCIAL'] -- now it IS protected.
    expect(await protectCategoryPrimary(['a'], ['CATEGORY_SOCIAL'])).toEqual([])
  })
})

// === bulkModifyByQuery integration ===

describe('bulkModifyByQuery', () => {
  it('runs the full pipeline: list -> protectCategoryPrimary -> batchModify', async () => {
    // 1. messages.list returns 3 ids
    // 2. messages.get for each returns labelIds -- 'a' has CATEGORY_PRIMARY
    // 3. batchModify is called with only 'b' and 'c'
    let step = 0
    setNextResponse((req) => {
      if (req.url.includes('/messages?') && req.method === 'GET') {
        return { status: 200, body: JSON.stringify({ messages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }) }
      }
      if (req.url.includes('/messages/a')) return { status: 200, body: JSON.stringify({ labelIds: ['INBOX', 'CATEGORY_PRIMARY'] }) }
      if (req.url.includes('/messages/b')) return { status: 200, body: JSON.stringify({ labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] }) }
      if (req.url.includes('/messages/c')) return { status: 200, body: JSON.stringify({ labelIds: ['INBOX', 'CATEGORY_SOCIAL'] }) }
      if (req.url.includes('batchModify')) {
        return { status: 204, body: '' }
      }
      return { status: 200, body: '{}' }
    })

    const result = await bulkModifyByQuery('category:promotions', {
      addLabelIds: ['TRASH'],
      removeLabelIds: ['INBOX'],
      maxCount: 100,
      protectCategoryPrimary: true,
    })
    expect(result.matched).toBe(3)
    expect(result.protected).toBe(1)   // 'a' dropped
    expect(result.modified).toBe(2)
    expect(result.ids).toEqual(['b', 'c'])
    const batchCall = recordedCalls.find(c => c.url.includes('batchModify'))
    expect(batchCall).toBeDefined()
    expect(JSON.parse(batchCall!.body!).ids).toEqual(['b', 'c'])
    expect(JSON.parse(batchCall!.body!).addLabelIds).toEqual(['TRASH'])
    expect(JSON.parse(batchCall!.body!).removeLabelIds).toEqual(['INBOX'])
  })

  it('refuses to run if matched > maxCount', async () => {
    setNextResponse({
      status: 200,
      body: JSON.stringify({ messages: Array.from({ length: 10 }, (_, i) => ({ id: `id-${i}` })) }),
    })
    await expect(bulkModifyByQuery('q', { maxCount: 5 })).rejects.toThrow(/exceeds maxCount=5/)
  })

  it('returns matched=0, modified=0 when nothing matches', async () => {
    setNextResponse({ status: 200, body: JSON.stringify({ messages: [] }) })
    const r = await bulkModifyByQuery('nothing')
    expect(r).toEqual({ matched: 0, protected: 0, modified: 0, ids: [], errors: [] })
  })

  it('protectCategoryPrimary:false skips the metadata fetch entirely', async () => {
    setNextResponse((req) => {
      if (req.url.includes('/messages?') && req.method === 'GET') {
        return { status: 200, body: JSON.stringify({ messages: [{ id: 'a' }, { id: 'b' }] }) }
      }
      if (req.url.includes('batchModify')) return { status: 204, body: '' }
      return { status: 200, body: '{}' }
    })
    const r = await bulkModifyByQuery('q', { protectCategoryPrimary: false })
    expect(r.modified).toBe(2)
    // The metadata fetches are the only URLs carrying `format=metadata`.
    const metadataCalls = recordedCalls.filter(c => c.url.includes('format=metadata'))
    expect(metadataCalls).toHaveLength(0)
  })
})

describe('markReadByQuery', () => {
  it('removes only the UNREAD label and never trashes', async () => {
    setNextResponse((req) => {
      if (req.url.includes('/messages?') && req.method === 'GET') {
        return { status: 200, body: JSON.stringify({ messages: [{ id: 'm1' }, { id: 'm2' }] }) }
      }
      if (req.url.includes('batchModify')) return { status: 204, body: '' }
      return { status: 200, body: '{}' }
    })
    const r = await markReadByQuery('category:updates is:unread older_than:1d')
    expect(r.matched).toBe(2)
    expect(r.modified).toBe(2)
    const batchCall = recordedCalls.find(c => c.url.includes('batchModify'))
    expect(batchCall).toBeDefined()
    const body = JSON.parse(batchCall!.body!)
    expect(body.removeLabelIds).toEqual(['UNREAD'])
    expect(body.addLabelIds).toEqual([])
  })

  it('does NOT engage the protectCategoryPrimary metadata fetch (mark-read is reversible)', async () => {
    setNextResponse((req) => {
      if (req.url.includes('/messages?')) {
        return { status: 200, body: JSON.stringify({ messages: [{ id: 'x' }] }) }
      }
      if (req.url.includes('batchModify')) return { status: 204, body: '' }
      return { status: 200, body: '{}' }
    })
    await markReadByQuery('q')
    const metadataFetches = recordedCalls.filter(c => /\/messages\/x(\?|$)/.test(c.url))
    expect(metadataFetches).toHaveLength(0)
  })
})

// === extractInvoiceData (with mocked LLM endpoint) ===

describe('extractInvoiceData', () => {
  it('returns null when ANTHROPIC_BASE_URL is not set', async () => {
    const saved = process.env['ANTHROPIC_BASE_URL']
    const savedAuth = process.env['ANTHROPIC_AUTH_TOKEN']
    delete process.env['ANTHROPIC_BASE_URL']
    delete process.env['ANTHROPIC_AUTH_TOKEN']
    try {
      expect(await extractInvoiceData('body', 'from@example', 'id')).toBeNull()
    } finally {
      if (saved !== undefined) process.env['ANTHROPIC_BASE_URL'] = saved
      if (savedAuth !== undefined) process.env['ANTHROPIC_AUTH_TOKEN'] = savedAuth
    }
  })

  it('parses a well-formed LLM JSON response into InvoiceData', async () => {
    setNextResponse({
      status: 200,
      body: JSON.stringify({
        content: [{ type: 'text', text: '{"date":"2026-09-15","amount":12990,"currency":"HUF","description":"Yettel havi számla"}' }],
      }),
    })
    const r = await extractInvoiceData('Yettel számla...', 'Yettel <info@yettel.hu>', 'msg-42')
    expect(r).toEqual({
      date: '2026-09-15',
      amount: 12990,
      currency: 'HUF',
      description: 'Yettel havi számla',
      source_email_id: 'msg-42',
    })
  })

  it('returns null when the LLM signals "not an invoice" with the literal null', async () => {
    setNextResponse({
      status: 200,
      body: JSON.stringify({ content: [{ type: 'text', text: 'null' }] }),
    })
    expect(await extractInvoiceData('shipping update', 'from@x', 'id')).toBeNull()
  })

  it('returns null on a non-200 LLM response', async () => {
    setNextResponse({ status: 500, body: 'llm down' })
    expect(await extractInvoiceData('body', 'from@x', 'id')).toBeNull()
  })

  it('returns null on a non-JSON LLM response', async () => {
    setNextResponse({
      status: 200,
      body: JSON.stringify({ content: [{ type: 'text', text: 'definitely not json' }] }),
    })
    expect(await extractInvoiceData('body', 'from@x', 'id')).toBeNull()
  })

  it('returns null when the parsed JSON fails validation (e.g. negative amount)', async () => {
    setNextResponse({
      status: 200,
      body: JSON.stringify({
        content: [{ type: 'text', text: '{"date":"2026-09-01","amount":-5,"currency":"HUF","description":"X"}' }],
      }),
    })
    expect(await extractInvoiceData('body', 'from@x', 'id')).toBeNull()
  })

  it('strips markdown code fences if the model wraps the JSON anyway', async () => {
    setNextResponse({
      status: 200,
      body: JSON.stringify({
        content: [{ type: 'text', text: '```json\n{"date":"2026-09-01","amount":1,"currency":"EUR","description":"X"}\n```' }],
      }),
    })
    const r = await extractInvoiceData('body', 'from@x', 'id')
    expect(r?.currency).toBe('EUR')
  })
})

// === Runner integration (mocked at every layer) ===

describe('runGmailCleanupNow (4-step pipeline)', () => {
  // The four steps call different Gmail queries. We route the canned
  // responses by inspecting the URL's `q=` parameter so each step sees a
  // distinct, plausible payload.
  function cannedResponseForQuery(url: string): { status: number; body: string } {
    // decodeURIComponent handles %XX but NOT `+` (which Gmail sends for
    // space). Replace `+` -> space to get a query string we can match on.
    const raw = (url.match(/[?&]q=([^&]+)/) ?? [, ''])[1]
    const q = decodeURIComponent(raw).replace(/\+/g, ' ')
    if (q.startsWith('category:(promotions')) {
      return { status: 200, body: JSON.stringify({ messages: [{ id: 'promo-1' }, { id: 'promo-2' }] }) }
    }
    if (q.startsWith('category:updates is:unread')) {
      return { status: 200, body: JSON.stringify({ messages: [{ id: 'updates-1' }, { id: 'updates-2' }, { id: 'updates-3' }] }) }
    }
    if (q.startsWith('category:updates newer_than:3d')) {
      return { status: 200, body: JSON.stringify({ messages: [{ id: 'invoice-1' }] }) }
    }
    if (q.startsWith('from:zavada.andrea@gmail.com')) {
      return { status: 200, body: JSON.stringify({ messages: [{ id: 'andi-1' }] }) }
    }
    if (q.startsWith('rfc822msgid:')) {
      return { status: 200, body: JSON.stringify({ messages: [{ id: 'andi-1' }] }) }
    }
    return { status: 200, body: JSON.stringify({ messages: [] }) }
  }

  function setRunnerFetch(): void {
    setNextResponse((req) => {
      // Order matters: most specific first. The metadata-fetch regex below
      // would also match `/messages/batchModify` because the id-segment is
      // anything-but-slash-or-`?`, so handle batchModify before the metadata
      // branch.
      if (req.url.includes('batchModify')) {
        return { status: 204, body: '' }
      }
      if (req.url.match(/\/messages\/[^/?]+(\?|$)/)) {
        // Metadata fetch for a single message (format=metadata or metadataHeaders=...).
        // Default: no CATEGORY_PRIMARY / no CATEGORY_PERSONAL labels.
        return {
          status: 200,
          body: JSON.stringify({
            labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'],
            payload: {
              headers: [
                { name: 'From', value: 'x@y.com' },
                { name: 'Subject', value: 's' },
              ],
            },
          }),
        }
      }
      if (req.url.includes('/messages?') && req.method === 'GET') {
        return cannedResponseForQuery(req.url)
      }
      if (req.url.includes('calendar/v3')) {
        return { status: 200, body: JSON.stringify({ id: 'cal-evt-1', htmlLink: 'https://calendar.google.com/event?eid=1' }) }
      }
      if (req.url.includes('openidconnect')) {
        return { status: 200, body: JSON.stringify({ email: 'alex@gmail.com' }) }
      }
      if (req.url.includes('anthropic') || req.url.includes('v1/messages')) {
        // Invoice extraction: not an invoice
        return { status: 200, body: JSON.stringify({ content: [{ type: 'text', text: 'null' }] }) }
      }
      return { status: 200, body: '{}' }
    })
  }

  it('runs all 4 steps and reports each one', async () => {
    setRunnerFetch()
    const results = await runGmailCleanupNow()
    expect(results).toHaveLength(4)
    const names = results.map(r => r.step)
    expect(names).toEqual(['trash', 'mark-read', 'calendar-extract', 'andi-reply'])
    for (const r of results) expect(r.ok).toBe(true)
  })

  it('trashStep issues a TRASH batchModify for category:(promotions OR social OR forums) older_than:7d', async () => {
    setRunnerFetch()
    const [trash] = await runGmailCleanupNow()
    expect(trash.step).toBe('trash')
    const listCall = recordedCalls.find(c => c.url.includes('/messages?') && c.url.includes('category%3A%28promotions'))
    expect(listCall).toBeDefined()
    const batchCall = recordedCalls.find(c => c.url.includes('batchModify'))
    expect(batchCall).toBeDefined()
    const body = JSON.parse(batchCall!.body!)
    expect(body.addLabelIds).toEqual(['TRASH'])
    expect(body.removeLabelIds).toEqual(['INBOX'])
  })

  it('markReadStep removes only UNREAD (NEVER trashes)', async () => {
    setRunnerFetch()
    await runGmailCleanupNow()
    const batchCalls = recordedCalls.filter(c => c.url.includes('batchModify'))
    // The mark-read step's batchModify must not include TRASH in addLabelIds
    // and must include UNREAD in removeLabelIds.
    const markReadBatch = batchCalls.find((_, idx) => idx === 1)
    expect(markReadBatch).toBeDefined()
    const body = JSON.parse(markReadBatch!.body!)
    expect(body.addLabelIds).toEqual([])
    expect(body.removeLabelIds).toEqual(['UNREAD'])
    // and: no other batchModify in the whole run adds TRASH besides the trash step
    const trashBatches = batchCalls.filter(c => JSON.parse(c.body!).addLabelIds?.includes('TRASH'))
    expect(trashBatches.length).toBeLessThanOrEqual(1)
  })
})

// === Manual regression recipe (logged, not auto-run) ===

// Last describe block: the manual regression recipe Alex runs against the
// live Gmail account after deploying. The block contains a `it` that
// INTENTIONALLY documents the steps -- it is not a code test, but it lives
// here so the recipe lives next to the tests that protect it. Marked
// `.skipIf(true)` to never auto-run; the body is checked via vitest's
// `expect.assertions` if someone un-skips it during a live rehearsal.
describe('manual regression recipe (live Gmail account, post-deploy)', () => {
  it.skipIf(true)('live rehearsal -- see body', async () => {
    // 1) Confirm CRON: src/web/gmail-cleanup-runner.ts sets `0 4 * * *`.
    // 2) Run the runner ON-DEMAND against the live account:
    //      $ tsx -e "import('./src/web/gmail-cleanup-runner.js').then(m => m.runGmailCleanupNow()).then(console.log)"
    // 3) Inspect the 4 step results:
    //    - trash: matched (>=0), protected (should be small, maybe a few
    //      promotions mis-categorised), modified > 0 if the backlog exists.
    //    - mark-read: matched > 0 if any updates-category unread.
    //    - calendar-extract: scanned > 0 if recent invoice-shaped mail
    //      exists; extracted > 0 only if the LLM recognised one. Check the
    //      Google Calendar primary for the new all-day events on the due
    //      dates; verify amount/currency/description in the event body.
    //    - andi-reply: scanned > 0 only if Andi emailed recently; replied > 0
    //      only if the gate passed (i.e. fromEnvelope == zavada.andrea@gmail.com).
    //      Confirm the reply landed in Andi's mailbox, NOT in someone else's.
    // 4) NO_TRASH_DEFAULT guard: send yourself a fake "binance.com" email
    //    tagged as category:promotions, wait for the next 04:00 run, then
    //    verify it survived in the inbox (NOT in TRASH).
    // 5) "Andini" negative control: send yourself a test email with display
    //    name "Andini" but a DIFFERENT address (e.g. andini@example.com).
    //    Verify the runner's andi-reply step scanned it but did NOT reply
    //    (the exact-match gate rejects it). isAndiSender() in the unit
    //    suite above already locks this in -- this step is the live check.
    expect(true).toBe(true)
  })
})
