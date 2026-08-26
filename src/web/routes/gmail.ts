import * as gmail from '../../gmail-api.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Dashboard-facing Gmail route. Mirrors the tryHandle* pattern used by the
// other route modules -- returns true if the request matched a /api/gmail
// path, false to let routing fall through to the next module / 404.
//
// Each handler is intentionally narrow: a clearly-bounded JSON shape in, the
// matching module call out, and a normalized JSON response. No streaming,
// no long-held IMAP connections (each handler opens + closes -- see
// gmail-api.ts:withImap).

export async function tryHandleGmail(ctx: RouteContext): Promise<boolean> {
  const path = ctx.path
  if (!path.startsWith('/api/gmail')) return false

  const { res, method } = ctx

  try {
    // Health/status: cheap reachability probe, exposed for the dashboard.
    if (path === '/api/gmail/status' && method === 'GET') {
      const s = await gmail.status()
      json(res, s)
      return true
    }

    // Inbox listing -- quick preview without bodies (fast).
    if (path === '/api/gmail/inbox' && method === 'GET') {
      const limit = parseIntOr(ctx.url.searchParams.get('limit'), 25)
      const sinceDays = parseIntOr(ctx.url.searchParams.get('sinceDays'), 0) || undefined
      const unreadOnly = ctx.url.searchParams.get('unreadOnly') === 'true'
      const fetchBody = ctx.url.searchParams.get('fetchBody') === 'true'
      const mailbox = ctx.url.searchParams.get('mailbox') ?? 'INBOX'
      const items = await gmail.listMessages({ mailbox, limit, sinceDays, unreadOnly, fetchBody })
      json(res, { count: items.length, items })
      return true
    }

    // Search across a mailbox. `q` is the IMAP TEXT search string.
    if (path === '/api/gmail/search' && method === 'GET') {
      const q = ctx.url.searchParams.get('q') ?? ''
      if (!q) { json(res, { error: 'q is required' }, 400); return true }
      const limit = parseIntOr(ctx.url.searchParams.get('limit'), 25)
      const fetchBody = ctx.url.searchParams.get('fetchBody') === 'true'
      const mailbox = ctx.url.searchParams.get('mailbox') ?? 'INBOX'
      const items = await gmail.searchMessages(q, { mailbox, limit, fetchBody })
      json(res, { count: items.length, items })
      return true
    }

    // Single-message detail (parses body).
    const detail = path.match(/^\/api\/gmail\/message\/([^/]+)$/)
    if (detail && method === 'GET') {
      const mailbox = ctx.url.searchParams.get('mailbox') ?? 'INBOX'
      const msg = await gmail.getMessage(detail[1], mailbox)
      if (!msg) { json(res, { error: 'not found' }, 404); return true }
      json(res, msg)
      return true
    }

    // Mutations -- marker-only endpoints so a typo doesn't accidentally
    // archive/unread every message in a sweep.
    if (path === '/api/gmail/mark-read' && method === 'POST') {
      const { uid, mailbox } = parseJsonBody<{ uid?: string; mailbox?: string }>(await readBody(ctx.req))
      if (!uid) { json(res, { error: 'uid required' }, 400); return true }
      await gmail.markRead(uid, mailbox ?? 'INBOX')
      json(res, { ok: true })
      return true
    }
    if (path === '/api/gmail/mark-unread' && method === 'POST') {
      const { uid, mailbox } = parseJsonBody<{ uid?: string; mailbox?: string }>(await readBody(ctx.req))
      if (!uid) { json(res, { error: 'uid required' }, 400); return true }
      await gmail.markUnread(uid, mailbox ?? 'INBOX')
      json(res, { ok: true })
      return true
    }
    if (path === '/api/gmail/star' && method === 'POST') {
      const { uid, mailbox } = parseJsonBody<{ uid?: string; mailbox?: string }>(await readBody(ctx.req))
      if (!uid) { json(res, { error: 'uid required' }, 400); return true }
      await gmail.star(uid, mailbox ?? 'INBOX')
      json(res, { ok: true })
      return true
    }
    if (path === '/api/gmail/unstar' && method === 'POST') {
      const { uid, mailbox } = parseJsonBody<{ uid?: string; mailbox?: string }>(await readBody(ctx.req))
      if (!uid) { json(res, { error: 'uid required' }, 400); return true }
      await gmail.unstar(uid, mailbox ?? 'INBOX')
      json(res, { ok: true })
      return true
    }
    if (path === '/api/gmail/archive' && method === 'POST') {
      const { uid } = parseJsonBody<{ uid?: string }>(await readBody(ctx.req))
      if (!uid) { json(res, { error: 'uid required' }, 400); return true }
      await gmail.archive(uid)
      json(res, { ok: true })
      return true
    }
    if (path === '/api/gmail/trash' && method === 'POST') {
      const { uid } = parseJsonBody<{ uid?: string }>(await readBody(ctx.req))
      if (!uid) { json(res, { error: 'uid required' }, 400); return true }
      await gmail.trash(uid)
      json(res, { ok: true })
      return true
    }

    // Send via Gmail SMTP. Bypassed for sub-agents by the email-send-gate
    // hook regardless of which transport the request claims to use.
    if (path === '/api/gmail/send' && method === 'POST') {
      const input = parseJsonBody<gmail.SendInput>(await readBody(ctx.req))
      if (!input || !input.to || !input.subject) {
        json(res, { error: 'to and subject required' }, 400)
        return true
      }
      if (!input.text && !input.html) {
        json(res, { error: 'either text or html is required' }, 400)
        return true
      }
      const result = await gmail.sendEmail(input)
      json(res, result)
      return true
    }

    // Bulk-trash by criteria. Used by the email-triage pipeline: nightly
    // job passes { beforeDays: 14, unreadOnly: true } to clear the backlog.
    // Returns the count + matched UIDs so the caller can audit what got hit.
    //
    // `protectedSenders`: optional list of email/domain strings to NEVER
    // trash. Match is substring on domain-style entries, exact on full
    // addresses (case-insensitive). Back-compat: omit/empty = no protection.
    if (path === '/api/gmail/bulk-trash' && method === 'POST') {
      const body = parseJsonBody<{
        beforeDays?: number
        unreadOnly?: boolean
        fromContains?: string
        maxCount?: number
        protectedSenders?: string[]
      }>(await readBody(ctx.req))
      if (typeof body.beforeDays !== 'number' || body.beforeDays <= 0) {
        json(res, { error: 'beforeDays (positive number) required' }, 400)
        return true
      }
      const before = new Date(Date.now() - body.beforeDays * 24 * 60 * 60 * 1000)
      const result = await gmail.bulkTrash({
        before,
        unreadOnly: body.unreadOnly !== false,
        fromContains: body.fromContains,
        maxCount: body.maxCount ?? 500,
        protectedSenders: body.protectedSenders,
      })
      json(res, result)
      return true
    }

    json(res, { error: 'not found', path }, 404)
    return true
  } catch (err) {
    logger.error({ err, path, method }, 'Gmail route error')
    const msg = (err as Error).message ?? 'unknown error'
    json(res, { error: msg }, 500)
    return true
  }
}

function parseIntOr(value: string | null, fallback: number): number {
  if (value === null) return fallback
  const n = parseInt(value, 10)
  return Number.isNaN(n) ? fallback : n
}

function parseJsonBody<T>(buf: Buffer): T {
  if (!buf || buf.length === 0) return {} as T
  try { return JSON.parse(buf.toString('utf-8')) as T } catch { return {} as T }
}