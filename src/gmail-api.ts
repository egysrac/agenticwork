import { ImapFlow, type ImapFlowOptions } from 'imapflow'
import nodemailer, { type Transporter } from 'nodemailer'
import { simpleParser, type Attachment } from 'mailparser'
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logger } from './logger.js'
import { STORE_DIR } from './config.js'

// Gmail manager.
//
// Two auth surfaces coexist in this module:
//
//   1) IMAP + SMTP via an app-specific password (`~/.gmail-mcp/credentials.json`).
//      This is the original auth path: it powers the read-side helpers
//      (listMessages, getMessage, searchMessages, decodeMimeHeader) and is also
//      kept available for the single-message mutations (markRead, star, archive,
//      trash). It is unchanged from the 1.34.x line.
//
//   2) Gmail REST API + Gmail SMTP XOAUTH2 via OAuth (`store/.google-oauth.json`).
//      This is the new auth path that powers the email-triage runner
//      (TRASH/MARK-READ/NAPTÁR-EXTRACT/ANDI-AUTO-REPLY). It uses the
//      gmail.modify + gmail.send + calendar scopes that are already in
//      `.google-oauth.json` -- no new OAuth flow needed.
//
// The OAuth helper functions are namespaced with a leading underscore so the
// public API stays tight. Tests override `globalThis.fetch` (and the in-module
// cached creds / token) to inject responses.

// === IMAP auth (unchanged) ===

const CREDS_DIR = join(homedir(), '.gmail-mcp')
const CREDS_PATH = join(CREDS_DIR, 'credentials.json')

const IMAP_HOST = 'imap.gmail.com'
const IMAP_PORT = 993
const SMTP_HOST = 'smtp.gmail.com'
const SMTP_PORT = 465

interface Credentials {
  username: string
  password: string
}

// Decoded normalized message, ready for JSON output to the dashboard.
export interface EmailMessage {
  id: string              // IMAP UID as string
  threadId: string        // Gmail threadId (X-GM-THRID)
  mailbox: string         // mailbox the message came from
  from: string
  to: string[]
  cc: string[]
  subject: string
  date: string            // ISO 8601 of message Date header
  snippet: string          // first ~200 chars of plain-text body
  bodyText?: string       // full plain-text body (when fetched)
  bodyHtml?: string       // full HTML body (when fetched)
  flags: string[]         // IMAP flags: \Seen, \Flagged, \Answered, etc.
  labels?: string[]       // Gmail labels (\Inbox, \Starred, custom, etc.)
  hasAttachments: boolean
  attachmentNames?: string[]
}

let cachedCreds: Credentials | null = null

function loadCredentials(): Credentials {
  if (cachedCreds) return cachedCreds
  if (!existsSync(CREDS_PATH)) {
    throw new Error(`Gmail credentials missing at ${CREDS_PATH}`)
  }
  const parsed = JSON.parse(readFileSync(CREDS_PATH, 'utf-8')) as Credentials
  if (!parsed.username || !parsed.password) {
    throw new Error('Gmail credentials file malformed (need username + password)')
  }
  parsed.password = parsed.password.replace(/\s+/g, '')
  cachedCreds = parsed
  return parsed
}

function imapOptions(): ImapFlowOptions {
  const c = loadCredentials()
  return {
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: c.username, pass: c.password },
    logger: false,
    emitLogs: false,
    socketTimeout: 5 * 60 * 1000,
    ...( { family: 4 } as any ),
  }
}

async function withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow(imapOptions())
  try {
    await client.connect()
    return await fn(client)
  } finally {
    try { await client.logout() } catch { /* fine */ }
  }
}

// === OAuth (Gmail API + SMTP XOAUTH2) ===

const OAUTH_PATH = join(STORE_DIR, '.google-oauth.json')

interface OAuthCreds {
  client_id: string
  client_secret: string
  token_uri: string
  refresh_token: string
  scopes: string[]
  access_token: string
  expiry_date: number      // ms epoch
  expires_in?: number      // seconds (from token response)
  obtained_at?: number     // seconds epoch
}

// Two-level cache so a hot loop doesn't reparse on every call, but a re-auth
// (which rewrites the file out-of-process) is still picked up via mtime.
let cachedOAuth: { value: OAuthCreds; mtimeMs: number } | null = null

function loadOAuthCreds(): OAuthCreds {
  let currentMtime = 0
  try { currentMtime = statSync(OAUTH_PATH).mtimeMs } catch { /* missing */ }
  if (!cachedOAuth || cachedOAuth.mtimeMs !== currentMtime) {
    const raw = JSON.parse(readFileSync(OAUTH_PATH, 'utf-8')) as Record<string, unknown>
    const creds: OAuthCreds = {
      client_id: String(raw['client_id'] ?? ''),
      client_secret: String(raw['client_secret'] ?? ''),
      token_uri: String(raw['token_uri'] ?? 'https://oauth2.googleapis.com/token'),
      refresh_token: String(raw['refresh_token'] ?? ''),
      scopes: Array.isArray(raw['scopes']) ? (raw['scopes'] as string[]).map(String) : [],
      access_token: String(raw['access_token'] ?? ''),
      // Synthesize expiry_date if missing -- some clients write obtained_at + expires_in.
      expiry_date: typeof raw['expiry_date'] === 'number'
        ? (raw['expiry_date'] as number)
        : (typeof raw['obtained_at'] === 'number' && typeof raw['expires_in'] === 'number')
          ? ((raw['obtained_at'] as number) + (raw['expires_in'] as number)) * 1000
          : 0,
      expires_in: typeof raw['expires_in'] === 'number' ? (raw['expires_in'] as number) : undefined,
      obtained_at: typeof raw['obtained_at'] === 'number' ? (raw['obtained_at'] as number) : undefined,
    }
    if (!creds.client_id || !creds.refresh_token) {
      throw new Error(`Google OAuth file malformed at ${OAUTH_PATH}`)
    }
    cachedOAuth = { value: creds, mtimeMs: currentMtime }
  }
  return cachedOAuth.value
}

function saveOAuthCreds(creds: OAuthCreds): void {
  writeFileSync(OAUTH_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 })
  let mtimeMs = 0
  try { mtimeMs = statSync(OAUTH_PATH).mtimeMs } catch { /* unlikely right after write */ }
  cachedOAuth = { value: creds, mtimeMs }
}

// Force re-read on next access (test helper).
export function _invalidateOAuthCache(): void {
  cachedOAuth = null
}

// HTTP wrapper around globalThis.fetch. Used by every OAuth helper. Tests
// override globalThis.fetch to inject canned responses (no live network).
//
// `body` is a plain object (will be JSON.stringify'd) OR a URLSearchParams for
// application/x-www-form-urlencoded (token endpoint). Default timeout 30s.
export async function _httpRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; timeoutMs?: number } = {},
  body?: string | URLSearchParams | Record<string, unknown>,
): Promise<{ status: number; data: string }> {
  const method = options.method ?? 'GET'
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  let payload: string | undefined
  if (body !== undefined) {
    if (body instanceof URLSearchParams) {
      payload = body.toString()
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/x-www-form-urlencoded'
    } else if (typeof body === 'string') {
      payload = body
    } else {
      payload = JSON.stringify(body)
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
    }
  }
  const timeoutMs = options.timeoutMs ?? 30_000

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method, headers, body: payload, signal: controller.signal })
    const data = await res.text()
    return { status: res.status, data }
  } finally {
    clearTimeout(timer)
  }
}

// Refresh the OAuth access_token. Writes the new token back to
// store/.google-oauth.json so a future cold start picks it up.
async function refreshAccessToken(): Promise<string> {
  const creds = loadOAuthCreds()
  const params = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
    grant_type: 'refresh_token',
  })
  const { status, data } = await _httpRequest(
    creds.token_uri,
    { method: 'POST' },
    params,
  )
  if (status !== 200) {
    logger.error({ status, body: data.slice(0, 200) }, 'Google OAuth token refresh failed')
    throw new Error(`OAuth token refresh failed: HTTP ${status}`)
  }
  let parsed: { access_token?: string; expires_in?: number }
  try {
    parsed = JSON.parse(data)
  } catch (e) {
    throw new Error(`OAuth token refresh returned non-JSON: ${(e as Error).message}`)
  }
  if (!parsed.access_token) {
    throw new Error('OAuth token refresh returned no access_token')
  }
  const updated: OAuthCreds = {
    ...creds,
    access_token: parsed.access_token,
    expiry_date: Date.now() + ((parsed.expires_in ?? 3600) * 1000),
    expires_in: parsed.expires_in,
    obtained_at: Math.floor(Date.now() / 1000),
  }
  saveOAuthCreds(updated)
  logger.info('Google OAuth access_token refreshed')
  return updated.access_token
}

// Return a non-expired access_token. Refreshes if expiry is within 5 minutes.
// Exported so the runner and tests can pre-warm / introspect.
export async function _accessToken(): Promise<string> {
  const creds = loadOAuthCreds()
  if (!creds.access_token || Date.now() > creds.expiry_date - 5 * 60 * 1000) {
    return refreshAccessToken()
  }
  return creds.access_token
}

// Validate that a scope is present in the stored credential. The runner
// calls this before sending email (gmail.send) so a missing scope is a loud
// error rather than a silent SMTP auth failure.
export function _hasScope(scope: string): boolean {
  const creds = loadOAuthCreds()
  return creds.scopes.includes(scope)
}

// Gmail messages.list wrapper: returns all message IDs matching the query,
// paginated via nextPageToken. Up to `maxResults` (default 500) per page.
export async function _listIds(
  query: string,
  opts: { maxResults?: number } = {},
): Promise<string[]> {
  const maxResults = opts.maxResults ?? 500
  const out: string[] = []
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({ q: query, maxResults: String(maxResults) })
    if (pageToken) params.set('pageToken', pageToken)
    const token = await _accessToken()
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`
    const { status, data } = await _httpRequest(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (status === 401) {
      // Token expired mid-flight: refresh once and retry.
      const newToken = await refreshAccessToken()
      const retry = await _httpRequest(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${newToken}` },
      })
      if (retry.status !== 200) {
        throw new Error(`Gmail messages.list retry failed: HTTP ${retry.status}`)
      }
      const parsed = JSON.parse(retry.data) as { messages?: { id: string }[]; nextPageToken?: string }
      for (const m of parsed.messages ?? []) out.push(m.id)
      pageToken = parsed.nextPageToken
      continue
    }
    if (status !== 200) {
      throw new Error(`Gmail messages.list failed: HTTP ${status}`)
    }
    const parsed = JSON.parse(data) as { messages?: { id: string }[]; nextPageToken?: string }
    for (const m of parsed.messages ?? []) out.push(m.id)
    pageToken = parsed.nextPageToken
  } while (pageToken)
  return out
}

// Gmail batchModify wrapper. Adds/removes label IDs on many messages in one
// request. The API caps the ids array at 1000 -- we chunk to honour that.
export async function _batchModify(
  ids: string[],
  addLabelIds: string[] = [],
  removeLabelIds: string[] = [],
): Promise<void> {
  if (ids.length === 0) return
  const url = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify'
  const token = await _accessToken()
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000)
    const body = { ids: chunk, addLabelIds, removeLabelIds }
    const { status, data } = await _httpRequest(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }, body)
    if (status === 401) {
      const newToken = await refreshAccessToken()
      const retry = await _httpRequest(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${newToken}` },
      }, body)
      if (retry.status !== 204 && retry.status !== 200) {
        throw new Error(`Gmail batchModify retry failed: HTTP ${retry.status}`)
      }
      continue
    }
    if (status !== 204 && status !== 200) {
      throw new Error(`Gmail batchModify failed: HTTP ${status} ${data.slice(0, 200)}`)
    }
  }
}

// === IMAP envelope mapping ===

function envelopeToMessage(env: any, mailbox: string, flags: Set<string>, labels?: string[], uid?: number): EmailMessage {
  const splitAddresses = (raw: any): string[] => {
    if (!raw) return []
    if (Array.isArray(raw)) return raw.map((a: any) => decodeMimeHeader(a)).filter(Boolean)
    if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean)
    return [decodeMimeHeader(raw)]
  }
  const uidStr = uid !== undefined ? String(uid) : (env.uid !== undefined ? String(env.uid) : '')
  return {
    id: uidStr,
    threadId: env['x-gm-thrid'] ? String(env['x-gm-thrid']) : uidStr,
    mailbox,
    from: decodeMimeHeader(env.from),
    to: splitAddresses(env.to),
    cc: splitAddresses(env.cc),
    subject: decodeMimeHeader(env.subject) || '(no subject)',
    date: env.date ? new Date(env.date).toISOString() : new Date().toISOString(),
    snippet: (env['x-gm-msgid'] || '').toString(),
    flags: Array.from(flags),
    labels: labels ?? [],
    hasAttachments: false,
  }
}

function decodeAddresses(value: any): string {
  return decodeMimeHeader(value)
}

async function parseSourceToBodies(source: Buffer): Promise<{ text?: string; html?: string; attachments: string[] }> {
  const parsed = await simpleParser(source)
  const attachments = (parsed.attachments ?? []).map((a: Attachment) => a.filename ?? 'unnamed')
  return {
    text: parsed.text ?? undefined,
    html: typeof parsed.html === 'string' ? parsed.html : undefined,
    attachments,
  }
}

function buildSnippet(text: string, max = 200): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > max ? normalized.slice(0, max) + '...' : normalized
}

async function resolveMailbox(client: ImapFlow, name: string): Promise<string> {
  const lists = await client.list()
  const upper = name.toUpperCase()
  const match = lists.find(m => m.path.toUpperCase() === upper)
    ?? lists.find(m => m.path.toUpperCase().startsWith(upper))
    ?? lists.find(m => upper.startsWith(m.path.toUpperCase()))
  if (!match) throw new Error(`Mailbox not found: ${name}`)
  return match.path
}

// Fix common MIME encoding artifacts in subject/from headers.
// EXPORTED (2026-08-26): integration tests use the full
// fetchEnvelopeFrom -> isProtectedSender chain, which needs this.
export function decodeMimeHeader(value: any): string {
  if (value === null || value === undefined) return ''
  if (typeof value !== 'string') {
    if (Array.isArray(value)) {
      return value.map(decodeMimeHeader).filter(Boolean).join(', ')
    }
    if (typeof value === 'object') {
      const name = value.name ? String(value.name) : ''
      const addr = value.address || (value.mailbox && value.host
        ? `${value.mailbox}@${value.host}` : '')
      return name && addr ? `${name} <${addr}>` : (name || addr || '')
    }
    return String(value)
  }
  return value.replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g, (_m, _cs, enc: string, text: string) => {
    try {
      if (enc.toUpperCase() === 'B') {
        return Buffer.from(text, 'base64').toString('utf-8')
      }
      return text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m2, hex) =>
        String.fromCharCode(parseInt(hex, 16)))
    } catch {
      return text
    }
  })
}

// === Public API: IMAP read ===

export interface ListOptions {
  mailbox?: string
  limit?: number
  sinceDays?: number
  unreadOnly?: boolean
  fetchBody?: boolean
}

export async function listMessages(opts: ListOptions = {}): Promise<EmailMessage[]> {
  const limit = Math.min(opts.limit ?? 25, 200)
  return withImap(async (client) => {
    const mb = await resolveMailbox(client, opts.mailbox ?? 'INBOX')
    await client.mailboxOpen(mb)
    const query: any = {}
    if (opts.sinceDays) {
      query.since = new Date(Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000)
    }
    if (opts.unreadOnly) query.unseen = true
    const searchArg = Object.keys(query).length === 0 ? true : query
    const uids = await client.search(searchArg, { uid: true })
    if (!uids) return []
    const arr = Array.isArray(uids) ? uids : []
    if (arr.length === 0) return []
    const latest = arr.slice(-limit).reverse()
    if (latest.length === 0) return []
    return await fetchUids(client, mb, latest, !!opts.fetchBody)
  })
}

async function fetchUids(client: ImapFlow, mailbox: string, uids: number[], withBody: boolean): Promise<EmailMessage[]> {
  const out: EmailMessage[] = []
  const query = withBody
    ? { envelope: true, flags: true, labels: true, source: true }
    : { envelope: true, flags: true, labels: true }
  const opts = { uid: true } as any
  for await (const msg of client.fetch(uids, query as any, opts)) {
    const env = (msg as any).envelope
    if (!env) continue
    const flags = new Set<string>(((msg as any).flags ?? []) as string[])
    const labels = ((msg as any).labels ?? []) as string[]
    const m = envelopeToMessage(env, mailbox, flags, labels, (msg as any).uid)

    if (withBody && (msg as any).source) {
      try {
        const buf = Buffer.isBuffer((msg as any).source) ? (msg as any).source : Buffer.from((msg as any).source)
        const { text, html, attachments } = await parseSourceToBodies(buf)
        m.bodyText = text
        m.bodyHtml = html
        m.hasAttachments = attachments.length > 0
        m.attachmentNames = attachments.length > 0 ? attachments : undefined
        m.snippet = text ? buildSnippet(text) : ''
      } catch (e) {
        logger.warn({ err: e, uid: m.id }, 'Failed to parse message body')
      }
    }
    out.push(m)
  }
  return out
}

export async function getMessage(uid: string, mailbox = 'INBOX'): Promise<EmailMessage | null> {
  const targetUid = parseInt(uid, 10)
  if (Number.isNaN(targetUid)) throw new Error(`Invalid UID: ${uid}`)
  return withImap(async (client) => {
    const mb = await resolveMailbox(client, mailbox)
    await client.mailboxOpen(mb)
    const msgs = await fetchUids(client, mb, [targetUid], true)
    return msgs[0] ?? null
  })
}

// Check whether a sender address matches any of the protected entries.
// Kept (and unchanged) so the existing IMAP single-message flows still work.
export function isProtectedSender(sender: string, protectedSenders: string[] | undefined): boolean {
  if (!sender || !protectedSenders || protectedSenders.length === 0) return false
  const lower = sender.toLowerCase()
  const angle = lower.match(/<([^>]+)>/)
  const addr = angle ? angle[1].trim() : lower
  for (const raw of protectedSenders) {
    const p = raw.trim().toLowerCase()
    if (!p) continue
    if (p.includes('@')) {
      if (addr === p || lower === p) return true
    } else {
      if (lower.includes('@' + p)) return true
    }
  }
  return false
}

// IMAP search across from/subject/body. Kept for dashboard / plugin use.
export async function searchMessages(query: string, opts: ListOptions = {}): Promise<EmailMessage[]> {
  const limit = Math.min(opts.limit ?? 25, 200)
  return withImap(async (client) => {
    const mb = await resolveMailbox(client, opts.mailbox ?? 'INBOX')
    await client.mailboxOpen(mb)
    const searchObj: any = { body: query, subject: query, from: query }
    if (opts.sinceDays) {
      searchObj.since = new Date(Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000)
    }
    if (opts.unreadOnly) searchObj.unseen = true
    const uids = await client.search({ or: [searchObj] }, { uid: true })
    if (!uids) return []
    const arr = Array.isArray(uids) ? uids : []
    if (arr.length === 0) return []
    return await fetchUids(client, mb, arr.slice(-limit).reverse(), !!opts.fetchBody)
  })
}

// === Public API: IMAP mutations (single-message) ===

async function setFlags(uid: string, mailbox: string, flags: string[], action: 'add' | 'remove'): Promise<void> {
  await withImap(async (client) => {
    const mb = await resolveMailbox(client, mailbox)
    await client.mailboxOpen(mb)
    const targetUid = parseInt(uid, 10)
    if (action === 'add') {
      await client.messageFlagsAdd(targetUid, flags)
    } else {
      await client.messageFlagsRemove(targetUid, flags)
    }
  })
}

export const markRead = (uid: string, mailbox = 'INBOX') =>
  setFlags(uid, mailbox, ['\\Seen'], 'add')

export const markUnread = (uid: string, mailbox = 'INBOX') =>
  setFlags(uid, mailbox, ['\\Seen'], 'remove')

export const star = (uid: string, mailbox = 'INBOX') =>
  setFlags(uid, mailbox, ['\\Flagged'], 'add')

export const unstar = (uid: string, mailbox = 'INBOX') =>
  setFlags(uid, mailbox, ['\\Flagged'], 'remove')

export const archive = (uid: string) =>
  setFlags(uid, 'INBOX', ['\\Inbox'], 'remove')

export const trash = (uid: string) =>
  setFlags(uid, 'INBOX', ['\\Trash'], 'add')

// === Public API: OAuth mutations (bulk, by Gmail query) ===

export interface BulkModifyByQueryOptions {
  addLabelIds?: string[]    // e.g. ['TRASH']
  removeLabelIds?: string[] // e.g. ['INBOX', 'UNREAD']
  // Hard safety cap. Refuses to apply the mutation to more than this many
  // messages in a single call (returns the partial result). Default 500.
  maxCount?: number
  // When true, drop any id whose labelIds include CATEGORY_PRIMARY or
  // CATEGORY_PERSONAL before the batchModify. The label fetch is one extra
  // API call per id -- but Gmail batchModify is the ONLY way to apply
  // labels, so without this filter a typo'd query can sweep important mail.
  protectCategoryPrimary?: boolean
  // Senders to never act on (post-fetch, before batchModify). Match is
  // case-insensitive substring on domain-style entries, exact on full
  // addresses. Empty / undefined = no protection. The fetch for the From
  // header is one extra API call per id (the batchModify endpoint doesn't
  // return the message contents).
  protectedSenders?: string[]
}

export interface BulkModifyResult {
  matched: number
  protected: number      // matched BUT skipped due to protectCategoryPrimary / protectedSenders
  modified: number
  ids: string[]          // ids actually modified
  errors: { id: string; error: string }[]
}

// Gmail category label IDs we must never auto-modify. CATEGORY_PERSONAL is
// the inbox's manual category; CATEGORY_PRIMARY is Gmail's "Important"
// auto-label (the one the human "Primary" tab shows). Both must survive any
// sweep or a real conversation can vanish.
const PRIMARY_CATEGORY_LABELS = ['CATEGORY_PRIMARY', 'CATEGORY_PERSONAL']

// Filter `ids` against the Gmail API's messages.get labelIds. Returns the
// subset that does NOT carry a primary-category label.
//
// Used as the post-fetch safety net on every bulk mutation. A query like
// `category:updates` cannot leak into CATEGORY_PRIMARY, but a typo'd custom
// query CAN, and the user-facing damage is the same: an important email is
// trashed. The cost is one extra API call per id -- measured at ~50ms per
// fetch against a warm cache; acceptable for the protection it buys.
//
// `primaryCategoryLabels` is parameterised for testing (default
// PRIMARY_CATEGORY_LABELS).
export async function protectCategoryPrimary(
  ids: string[],
  primaryCategoryLabels: string[] = PRIMARY_CATEGORY_LABELS,
): Promise<string[]> {
  if (ids.length === 0) return []
  const safeLabels = new Set(primaryCategoryLabels)
  const token = await _accessToken()
  // Parallelise the metadata fetches -- Gmail has no batch endpoint for
  // messages.get, but parallel HTTP is fine here. Cap concurrency at 10 so a
  // 500-id batch does not overwhelm the API.
  const out: string[] = []
  const concurrency = 10
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < ids.length) {
      const idx = cursor++
      const id = ids[idx]
      const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata`
      try {
        const { status, data } = await _httpRequest(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        })
        if (status !== 200) {
          // Fail open: if we can't determine labels, include the id.
          // The runner will then log this in errors[] (next step).
          out.push(id)
          continue
        }
        const parsed = JSON.parse(data) as { labelIds?: string[] }
        const labels = parsed.labelIds ?? []
        const isProtected = labels.some(l => safeLabels.has(l))
        if (!isProtected) out.push(id)
      } catch {
        out.push(id)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()))
  return out
}

// Apply a Gmail label modification to every message matching `query`. The
// work pipeline:
//
//   1) _listIds(query)              -> matched ids
//   2) protectCategoryPrimary(ids)  -> drop CATEGORY_PRIMARY/PERSONAL
//   3) optional From-header check   -> drop protectedSenders
//   4) _batchModify(safe ids, add, remove)
//
// This replaces the old IMAP-based bulkTrash. Backward-compatible shape:
// callers passing { addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] } get
// the same end state.
export async function bulkModifyByQuery(
  query: string,
  opts: BulkModifyByQueryOptions = {},
): Promise<BulkModifyResult> {
  const maxCount = opts.maxCount ?? 500
  const addLabelIds = opts.addLabelIds ?? []
  const removeLabelIds = opts.removeLabelIds ?? []
  const hasProtection = opts.protectCategoryPrimary !== false  // default ON
  const hasProtectedSenders = Array.isArray(opts.protectedSenders) && opts.protectedSenders.length > 0

  const matchedIds = await _listIds(query)
  if (matchedIds.length > maxCount) {
    throw new Error(`Matched ${matchedIds.length} messages, exceeds maxCount=${maxCount}. Refusing to bulk-modify.`)
  }

  let safeIds = matchedIds
  let primaryProtected = 0
  if (hasProtection) {
    safeIds = await protectCategoryPrimary(safeIds)
    primaryProtected = matchedIds.length - safeIds.length
  }

  let senderProtected = 0
  if (hasProtectedSenders && safeIds.length > 0) {
    const token = await _accessToken()
    const filtered: string[] = []
    for (const id of safeIds) {
      const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From`
      const { status, data } = await _httpRequest(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (status !== 200) {
        // Fail open on individual fetches -- the batchModify will still
        // apply, and the From-check is best-effort.
        filtered.push(id)
        continue
      }
      const parsed = JSON.parse(data) as { payload?: { headers?: { name?: string; value?: string }[] } }
      const fromHeader = parsed.payload?.headers?.find(h => h.name?.toLowerCase() === 'from')?.value ?? ''
      if (isProtectedSender(fromHeader, opts.protectedSenders)) {
        senderProtected++
      } else {
        filtered.push(id)
      }
    }
    safeIds = filtered
  }

  if (safeIds.length === 0) {
    return {
      matched: matchedIds.length,
      protected: primaryProtected + senderProtected,
      modified: 0,
      ids: [],
      errors: [],
    }
  }

  const errors: { id: string; error: string }[] = []
  try {
    await _batchModify(safeIds, addLabelIds, removeLabelIds)
  } catch (e) {
    // batchModify is atomic per call -- if it throws, attribute the failure
    // to every id in the chunk so the caller can see what was lost.
    for (const id of safeIds) errors.push({ id, error: (e as Error).message })
    return {
      matched: matchedIds.length,
      protected: primaryProtected + senderProtected,
      modified: 0,
      ids: [],
      errors,
    }
  }
  return {
    matched: matchedIds.length,
    protected: primaryProtected + senderProtected,
    modified: safeIds.length,
    ids: safeIds,
    errors: [],
  }
}

// Drop the UNREAD label on every message matching `query`. Does NOT touch
// the inbox label, does NOT trash. Idempotent -- running twice is harmless.
export async function markReadByQuery(query: string, opts: { maxCount?: number } = {}): Promise<BulkModifyResult> {
  return bulkModifyByQuery(query, {
    removeLabelIds: ['UNREAD'],
    addLabelIds: [],
    maxCount: opts.maxCount ?? 500,
    protectCategoryPrimary: false,   // mark-read is reversible, no need
    protectedSenders: undefined,
  })
}

// === Public API: OAuth sending (XOAUTH2) ===

// Cache the resolved mailbox address (the XOAUTH2 user). Gmail SMTP XOAUTH2
// requires the user to be the FULL MAILBOX ADDRESS (e.g. alex@gmail.com),
// not the OAuth client_id. We resolve it once via openid userinfo.
let cachedMailbox: string | null = null

export async function _ensureSmtpUsername(): Promise<string> {
  if (cachedMailbox) return cachedMailbox
  const token = await _accessToken()
  const { status, data } = await _httpRequest(
    'https://openidconnect.googleapis.com/v1/userinfo',
    { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
  )
  if (status !== 200) {
    throw new Error(`openid userinfo failed: HTTP ${status}`)
  }
  const parsed = JSON.parse(data) as { email?: string }
  if (!parsed.email) throw new Error('openid userinfo returned no email')
  cachedMailbox = parsed.email
  return cachedMailbox
}

// Reset cached SMTP username (test helper + after a token rotation).
export function _invalidateSmtpUsernameCache(): void {
  cachedMailbox = null
}

export interface SendInput {
  to: string | string[]
  subject: string
  text?: string
  html?: string
  cc?: string | string[]
  bcc?: string | string[]
  inReplyTo?: string
  references?: string
}

export interface SendResult {
  messageId: string
  accepted: string[]
  rejected: string[]
}

// Send via Gmail SMTP XOAUTH2. Requires the gmail.send scope; throws if it
// is missing (NEVER falls back to the IMAP app-password transport -- the
// audit trail is the whole point of using XOAUTH2).
export async function sendEmail(input: SendInput): Promise<SendResult> {
  if (!_hasScope('https://www.googleapis.com/auth/gmail.send')) {
    throw new Error('sendEmail: gmail.send scope missing in store/.google-oauth.json -- refusing to send')
  }
  const fromAddress = await _ensureSmtpUsername()
  // Refresh the access_token if it's about to expire (the SMTP socket opens
  // NOW, not later). nodemailer doesn't auto-refresh for OAuth2.
  const accessToken = await _accessToken()
  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: true,
    auth: {
      type: 'OAuth2',
      user: fromAddress,
      accessToken,
    },
  })
  const info = await transport.sendMail({
    from: fromAddress,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: input.text,
    html: input.html,
    inReplyTo: input.inReplyTo,
    references: input.references,
  })
  return {
    messageId: info.messageId,
    accepted: Array.isArray(info.accepted) ? info.accepted.map(String) : [],
    rejected: Array.isArray(info.rejected) ? info.rejected.map(String) : [],
  }
}

// Reset IMAP credential cache (kept for the legacy route; harmless).
export function invalidateCredentialCache(): void {
  cachedCreds = null
}

// Quick connectivity probe used by the dashboard /api/gmail/status endpoint.
// Reports both the IMAP reachability (legacy) and the OAuth token presence
// (new). The token presence is cheap and confirms the OAuth credential file
// is intact; actual scope/API access is exercised by the runner.
export interface StatusReport {
  ok: boolean
  imapReachable: boolean
  smtpConfigured: boolean
  oauthConfigured: boolean
  user: string
  error?: string
}

export async function status(): Promise<StatusReport> {
  let imapReachable = false
  let error: string | undefined
  try {
    await withImap(async (client) => {
      await client.noop()
      imapReachable = true
    })
  } catch (e) {
    error = (e as Error).message
  }
  let smtpConfigured = false
  try {
    const c = loadCredentials()
    if (c.username && c.password) smtpConfigured = true
  } catch (e) {
    if (!error) error = (e as Error).message
  }
  let oauthConfigured = false
  try {
    const c = loadOAuthCreds()
    if (c.refresh_token && c.client_id && c.scopes.length > 0) oauthConfigured = true
  } catch (e) {
    if (!error) error = (e as Error).message
  }
  return {
    ok: imapReachable || oauthConfigured,
    imapReachable,
    smtpConfigured,
    oauthConfigured,
    user: (() => {
      try { return loadCredentials().username } catch { return '' }
    })(),
    error,
  }
}

// === Andi auto-reply (TRIAGE826) ===

// Exact-match gate: the auto-reply helper ONLY accepts email From headers
// that are `zavada.andrea@gmail.com` OR a display-name envelope whose bare
// address matches it. "Andini" is intentionally NOT a match -- the original
// name guess was wrong, and the function exists precisely to prevent that
// kind of fuzzy match from leaking a reply to the wrong person.
//
// `fromEnvelope` is the decoded RFC822 From header (use decodeMimeHeader on
// the raw value to normalise address-objects / RFC 2047 into a string first).
export function isAndiSender(fromEnvelope: string): boolean {
  const raw = (fromEnvelope ?? '').trim()
  if (!raw) return false
  // Bare address form
  if (raw.toLowerCase() === 'zavada.andrea@gmail.com') return true
  // Envelope form: extract <addr> or fall back to the bare string
  const m = raw.match(/<([^>]+)>/)
  const addr = m ? m[1].trim().toLowerCase() : raw.toLowerCase()
  return addr === 'zavada.andrea@gmail.com'
}

// Send an auto-reply addressed to Andi. `input` is a normal SendInput. The
// fromEnvelope is the ORIGINAL email's From header (decoded) -- the function
// refuses to send if it does not match Andi exactly.
export async function andIEmailReply(
  input: SendInput,
  fromEnvelope: string,
): Promise<SendResult> {
  if (!isAndiSender(fromEnvelope)) {
    throw new Error(`andIEmailReply: refusing to reply to non-Andi sender "${fromEnvelope}"`)
  }
  if (!_hasScope('https://www.googleapis.com/auth/gmail.send')) {
    throw new Error('andIEmailReply: gmail.send scope missing')
  }
  return sendEmail(input)
}

// === Invoice data extraction (TRIAGE826) ===

export interface InvoiceData {
  date: string          // ISO 8601 (YYYY-MM-DD)
  amount: number        // positive number
  currency: 'HUF' | 'EUR' | 'USD'
  description: string
  source_email_id: string
}

// Validate a parsed LLM response against the InvoiceData schema. Returns the
// data on success, null on any failure (missing key / wrong type / bad date /
// negative or zero amount / unknown currency). The runner logs the LLM raw
// output (logger.info) BEFORE this validation runs, so the failure path is
// auditable.
export function validateInvoiceData(raw: unknown, sourceEmailId: string): InvoiceData | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const date = typeof r['date'] === 'string' ? r['date'].trim() : ''
  if (!date) return null
  // ISO 8601 YYYY-MM-DD is the only accepted shape (dateTime is rejected).
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const d = new Date(date + 'T00:00:00Z')
  if (Number.isNaN(d.getTime())) return null
  // Guard against Date overflow on a syntactically-valid but non-existent
  // date (e.g. 2026-02-31 -> JavaScript silently rolls forward to Mar 3).
  // Round-trip the parsed Date back to ISO and compare with the input.
  if (d.toISOString().slice(0, 10) !== date) return null
  const amountRaw = r['amount']
  const amount = typeof amountRaw === 'number' ? amountRaw : Number(amountRaw)
  if (!Number.isFinite(amount) || amount <= 0) return null
  const currencyRaw = typeof r['currency'] === 'string' ? r['currency'].trim().toUpperCase() : ''
  if (currencyRaw !== 'HUF' && currencyRaw !== 'EUR' && currencyRaw !== 'USD') return null
  const description = typeof r['description'] === 'string' ? r['description'].trim().slice(0, 500) : ''
  if (!description) return null
  return {
    date,
    amount,
    currency: currencyRaw as 'HUF' | 'EUR' | 'USD',
    description,
    source_email_id: sourceEmailId,
  }
}

// LLM prompt for the invoice extractor. Kept inline (not a SKILL.md file)
// because the only consumer is this module. The system prompt is locked to
// a strict JSON-only response so validateInvoiceData() can rely on the shape.
const EXTRACT_SYSTEM = `You extract invoice / payment-due data from an email body.
Respond with a single JSON object, nothing else, no prose, no markdown fences:
{"date":"YYYY-MM-DD","amount":<number>,"currency":"HUF"|"EUR"|"USD","description":"<short>"}
Rules:
- date: the DUE date if stated, otherwise the email date. ISO 8601 YYYY-MM-DD.
- amount: positive number, no thousands separators, no currency symbol.
- currency: exactly one of HUF, EUR, USD.
- description: a short (<=120 char) human-readable line, e.g. "Yettel havi számla".
If the email is NOT an invoice / payment-due, respond with exactly: null`

// Call the configured Anthropic-compatible endpoint and ask for InvoiceData.
// Uses ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN (or AUTH_TOKEN) + the
// ANTHROPIC_MODEL env vars, matching the rest of the fleet.
//
// Returns null on any failure (network / non-JSON / schema-invalid). The
// caller (runner) logs the raw LLM output via logger.info for auditability.
export async function extractInvoiceData(
  emailBody: string,
  fromHeader: string,
  sourceEmailId: string,
): Promise<InvoiceData | null> {
  const baseUrl = (process.env['ANTHROPIC_BASE_URL'] ?? '').replace(/\/+$/, '')
  const authToken = process.env['ANTHROPIC_AUTH_TOKEN'] ?? process.env['AUTH_TOKEN'] ?? ''
  const model = process.env['ANTHROPIC_MODEL'] ?? 'MiniMax-M3'
  if (!baseUrl || !authToken) {
    logger.warn('extractInvoiceData: ANTHROPIC_BASE_URL or ANTHROPIC_AUTH_TOKEN not set, returning null')
    return null
  }
  const userPayload = `From: ${fromHeader}\n\nBody:\n${emailBody.slice(0, 8000)}`
  const body = {
    model,
    max_tokens: 256,
    system: EXTRACT_SYSTEM,
    messages: [{ role: 'user', content: userPayload }],
  }
  const url = `${baseUrl}/v1/messages`
  let data: string
  try {
    const { status, data: respData } = await _httpRequest(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': authToken,
        'anthropic-version': '2023-06-01',
      },
    }, body)
    if (status !== 200) {
      logger.warn({ status, body: respData.slice(0, 200) }, 'extractInvoiceData: LLM non-200')
      return null
    }
    data = respData
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'extractInvoiceData: LLM request failed')
    return null
  }
  // Audit log: the raw LLM response, so a bad extraction is debuggable
  // from the logs without re-running.
  logger.info({ sourceEmailId, llmRaw: data.slice(0, 1000) }, 'extractInvoiceData: LLM response')

  // Pull the text block from the Anthropic Messages shape.
  let text: string
  try {
    const parsed = JSON.parse(data) as { content?: Array<{ type?: string; text?: string }> }
    const block = parsed.content?.find(b => b.type === 'text')
    text = block?.text ?? ''
  } catch {
    return null
  }
  if (!text) return null

  // Strip markdown fences if the model wrapped the JSON (best-effort -- the
  // system prompt forbids them, but LLMs occasionally ignore that).
  const stripped = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()

  if (stripped === 'null') return null
  let raw: unknown
  try {
    raw = JSON.parse(stripped)
  } catch {
    return null
  }
  return validateInvoiceData(raw, sourceEmailId)
}

// Setup helper (legacy, kept for parity with the old API).
export function _writeCredentialsForSetup(username: string, password: string): void {
  if (!existsSync(CREDS_DIR)) mkdirSync(CREDS_DIR, { recursive: true, mode: 0o700 })
  const cleanPwd = password.replace(/\s+/g, '')
  writeFileSync(CREDS_PATH, JSON.stringify({ username, password: cleanPwd }, null, 2), { mode: 0o600 })
}
