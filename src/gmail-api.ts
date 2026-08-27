import { ImapFlow, type ImapFlowOptions } from 'imapflow'
import nodemailer, { type Transporter } from 'nodemailer'
import { simpleParser, type Attachment } from 'mailparser'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logger } from './logger.js'

// Gmail manager via IMAP + SMTP, app-specific password authentication.
// IMAP for read/organize, SMTP for send.
//
// Auth creds live at ~/.gmail-mcp/credentials.json (0600), same shape as
// iCloud CalDAV. NEVER log the password. The same creds are used for both
// IMAP and SMTP since Gmail accepts the app password for both protocols.
//
// Why IMAP+SMTP and not the Gmail REST API:
// * No Google Cloud project, OAuth client, or consent screen needed
// * One-time secret generation in myaccount.google.com/apppasswords
// * Gmail API's only unique benefit is push (watch + Pub/Sub) -- out of scope

const CREDS_DIR = join(homedir(), '.gmail-mcp')
const CREDS_PATH = join(CREDS_DIR, 'credentials.json')

const IMAP_HOST = 'imap.gmail.com'
const IMAP_PORT = 993
const SMTP_HOST = 'smtp.gmail.com'
const SMTP_PORT = 465

interface Credentials {
  username: string  // full email address
  password: string  // 16-char app-specific password (NO spaces in stored copy)
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
  // Strip spaces from password -- user often pastes it "xxxx xxxx xxxx xxxx" form
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
    // Gmail IMAP has stricter timeouts on idle than ideal -- 5min keeps the
    // connection alive for short-lived operations without retry storms.
    socketTimeout: 5 * 60 * 1000,
    // Force IPv4. Server is dual-stacked but the IPv6 path through this
    // gateway hangs with ETIMEDOUT (observed 2026-08-19 against
    // 2a00:1450:4025:c01::6c). IPv4 to the same hostname works fine.
    ...( { family: 4 } as any ),
  }
}

// Open a fresh IMAP connection, run the callback, always close. Each public
// function here opens its own connection -- Gmail rate-limits open/close so
// this is a deliberate trade for safety over efficiency.
async function withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow(imapOptions())
  try {
    await client.connect()
    return await fn(client)
  } finally {
    try { await client.logout() } catch { /* fine */ }
  }
}

let cachedTransport: Transporter | null = null

function smtpTransport(): Transporter {
  if (cachedTransport) return cachedTransport
  const c = loadCredentials()
  cachedTransport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: true,  // implicit TLS on 465
    auth: { user: c.username, pass: c.password },
  })
  return cachedTransport
}

// Map IMAP envelope to our EmailMessage shape. Pulls text snippet eagerly
// (Gmail's precomputed TextPreview would be nicer but IMAP doesn't expose
// it directly -- fetchMessage snippet is ~200 chars).
function envelopeToMessage(env: any, mailbox: string, flags: Set<string>, labels?: string[], uid?: number): EmailMessage {
  // `to`/`cc` arrive from IMAP as either an array of address objects or a flat
  // string. Normalize to string[] for the dashboard shape.
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
    snippet: (env['x-gm-msgid'] || '').toString(),  // imapflow doesn't expose preview; we fetch body separately if needed
    flags: Array.from(flags),
    labels: labels ?? [],
    hasAttachments: false,  // populated by fetchMessage
  }
}

// Decode an IMAP address-list field value into a normalized string.
// (Kept as a thin pass-through -- envelopeToMessage now does all the heavy
// lifting via decodeMimeHeader, which understands both flat RFC 2047 strings
// and parsed address objects.)
function decodeAddresses(value: any): string {
  return decodeMimeHeader(value)
}

// Decode raw RFC822 source (Buffer) into parsed parts via mailparser.
async function parseSourceToBodies(source: Buffer): Promise<{ text?: string; html?: string; attachments: string[] }> {
  // simpleParser is async; runs mailparser internally and returns a ParsedMail.
  const parsed = await simpleParser(source)
  const attachments = (parsed.attachments ?? []).map((a: Attachment) => a.filename ?? 'unnamed')
  return {
    text: parsed.text ?? undefined,
    html: typeof parsed.html === 'string' ? parsed.html : undefined,
    attachments,
  }
}

// Fix common MIME encoding artifacts in subject/from headers.
//
// IMAP envelope fields can arrive as either a flat RFC 2047 string
// ("=?UTF-8?B?...?=") for subject, or a parsed object/array ({ name, mailbox,
// host, ... }) for address fields. Coerce non-strings before applying RFC 2047
// decoding so the rest of the pipeline always sees a string.
// EXPORTALT (2026-08-26): az integrációs tesztek a teljes fetchEnvelopeFrom
// -> isProtectedSender lancot zart lancban tesztelik, es ehhez szukseguk van
// ra (GMAILENV826 regression test).
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
  // RFC 2047 =?charset?Q?text?= or =?charset?B?base64?=
  return value.replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g, (_m, _cs, enc: string, text: string) => {
    try {
      if (enc.toUpperCase() === 'B') {
        return Buffer.from(text, 'base64').toString('utf-8')
      }
      // Q encoding: _ = space, =XX = hex
      return text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m2, hex) =>
        String.fromCharCode(parseInt(hex, 16)))
    } catch {
      return text
    }
  })
}

// Build a short preview from text body (we don't get Gmail's snippet via IMAP
// without an extra fetch).
function buildSnippet(text: string, max = 200): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > max ? normalized.slice(0, max) + '...' : normalized
}

// Get a mailbox name with system flag detection. Falls back through common
// aliases so a request for "INBOX" works regardless of server casing.
async function resolveMailbox(client: ImapFlow, name: string): Promise<string> {
  const lists = await client.list()
  const upper = name.toUpperCase()
  const match = lists.find(m => m.path.toUpperCase() === upper)
    ?? lists.find(m => m.path.toUpperCase().startsWith(upper))
    ?? lists.find(m => upper.startsWith(m.path.toUpperCase()))
  if (!match) throw new Error(`Mailbox not found: ${name}`)
  return match.path
}

// === Public API ===

export interface ListOptions {
  mailbox?: string       // default 'INBOX'
  limit?: number         // default 25, max 200
  sinceDays?: number     // optional: only messages from last N days
  unreadOnly?: boolean
  fetchBody?: boolean    // if true, fetch each message body too (slower)
}

export async function listMessages(opts: ListOptions = {}): Promise<EmailMessage[]> {
  const limit = Math.min(opts.limit ?? 25, 200)
  return withImap(async (client) => {
    const mb = await resolveMailbox(client, opts.mailbox ?? 'INBOX')
    await client.mailboxOpen(mb)
    // imapflow quirk: passing `{ all: '' }` makes the client emit `SEARCH ""`
    // which Gmail interprets as "no criteria = no matches" and returns false.
    // Pass `true` (which expands to `SEARCH ALL`) or an empty object instead
    // when no narrowing filters are set. Verified 2026-08-19 against Gmail
    // IMAP -- returning false on `search({all:''})` was the cause of the
    // empty inbox result.
    const query: any = {}
    if (opts.sinceDays) {
      query.since = new Date(Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000)
    }
    if (opts.unreadOnly) query.unseen = true
    const searchArg = Object.keys(query).length === 0 ? true : query
    const uids = await client.search(searchArg, { uid: true })
    // imapflow returns the search results as an array of UIDs, or `false` when
    // the server signals "no matches" via the IMAP SEARCH protocol. An empty
    // array also means "no matches" -- treat both identically.
    if (!uids) return []
    const arr = Array.isArray(uids) ? uids : []
    if (arr.length === 0) return []
    const latest = arr.slice(-limit).reverse()  // most recent first
    if (latest.length === 0) return []
    return await fetchUids(client, mb, latest, !!opts.fetchBody)
  })
}

async function fetchUids(client: ImapFlow, mailbox: string, uids: number[], withBody: boolean): Promise<EmailMessage[]> {
  const out: EmailMessage[] = []
  // imapflow's fetch() is an async iterator yielding one message per call.
  // `source` returns the raw RFC822 bytes (Buffer); we parse with mailparser
  // when bodies are needed. Gmail's X-GM-EXT-1 extension provides `labels` and
  // `threadId` -- both arrive as a Set / string respectively.
  //
  // Important: `uid: true` belongs in the OPTIONS (3rd arg), not the query.
  // imapflow treats numbers in `range` as sequence numbers unless the options
  // object says otherwise. Without it, `fetch([52936, 52937], ...)` issues a
  // UID FETCH with sequence numbers and the server returns nothing -- exactly
  // the bug that produced empty inbox results on 2026-08-19.
  const query = withBody
    ? { envelope: true, flags: true, labels: true, source: true }
    : { envelope: true, flags: true, labels: true }
  const opts = { uid: true } as any
  for await (const msg of client.fetch(uids, query as any, opts)) {
    const env = (msg as any).envelope
    if (!env) continue
    const flags = new Set<string>(((msg as any).flags ?? []) as string[])
    const labels = ((msg as any).labels ?? []) as string[]
    // envelopeToMessage does the RFC 2047 / address-object decoding inline.
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

// Fetch a single message by IMAP UID with body.
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

// Bulk operations: open ONE IMAP connection, apply flags to many messages.
// Used by the email triage pipeline -- avoids the 5-10s connect overhead per
// message that single-message `trash()` / `markRead()` would incur.

// IMAP search criteria for bulk-trash. Both `before` and `unseen` are part of
// the IMAP SEARCH grammar; imapflow translates them server-side.
export interface BulkTrashOptions {
  before?: Date       // message Date header < this
  after?: Date        // message Date header > this
  unreadOnly?: boolean
  fromContains?: string
  mailbox?: string
  // Safety cap: refuse to trash more than this many in one call. Default 500.
  maxCount?: number
  // Senders to never auto-trash. Match is case-insensitive substring:
  //   "salonic.hu"     -> any "@salonic.hu" address
  //   "alice@gmail.com" -> exact address only
  // Empty / undefined = no protection (back-compat).
  protectedSenders?: string[]
}

export interface BulkTrashResult {
  matched: number       // total found by search (before protection)
  protected: number     // matched BUT skipped because of protectedSenders
  trashed: number
  uids: number[]        // UIDs actually trashed (excludes protected)
  errors: { uid: number; error: string }[]
}

// Check whether a sender address matches any of the protected entries.
// Substring match on domain-style entries (no '@'), exact on full addresses.
// Backward compat: empty list = no protection.
export function isProtectedSender(sender: string, protectedSenders: string[] | undefined): boolean {
  if (!sender || !protectedSenders || protectedSenders.length === 0) return false
  const lower = sender.toLowerCase()
  // A felado gyakran "Nev <cim@domain>" boriteg-formatumban erkezik
  // (decodeMimeHeader), ezert eloszor kinyerjuk a csupasz cimet. Enelkul a
  // teljes cimes bejegyzes PONTOS egyezese elbukott a boritegre, es egy VEDETT
  // felado levele torolhetove valt volna. (2026-08-26)
  const angle = lower.match(/<([^>]+)>/)
  const addr = angle ? angle[1].trim() : lower
  for (const raw of protectedSenders) {
    const p = raw.trim().toLowerCase()
    if (!p) continue
    if (p.includes('@')) {
      // Full address: a csupasz cimre egyezunk (boriteg-tolerans)
      if (addr === p || lower === p) return true
    } else {
      // Domain-style: any "@<domain>" substring in the address qualifies.
      // "salonic.hu" matches "x@salonic.hu", "x@news.salonic.hu", "x@y.salonic.hu"
      if (lower.includes('@' + p)) return true
    }
  }
  return false
}

// Fetch the envelope From of a single UID. Throws if the UID can't be fetched
// (treated as a non-match by the caller). Used only when protectedSenders is
// set -- the per-UID envelope fetch adds latency vs. blind trashing.
async function fetchEnvelopeFrom(client: ImapFlow, uid: number): Promise<string> {
  const iter = client.fetch([uid], { envelope: true }, { uid: true } as any)
  for await (const msg of iter) {
    const env = (msg as any).envelope
    return decodeMimeHeader(env?.from) || ''
  }
  return ''
}

// Find messages matching the criteria and trash them in a single connection.
// Gmail's IMAP server sets the \Trash flag and moves the message to
// [Gmail]/Trash atomically. Reversible for 30 days via Gmail's UI.
//
// When `protectedSenders` is provided, each match is envelope-fetched to read
// the From address; protected senders are skipped, not trashed. The matched
// count includes protected ones (so the caller can see what was protected);
// `trashed` and `uids` reflect only the actual deletions.
export async function bulkTrash(opts: BulkTrashOptions): Promise<BulkTrashResult> {
  const maxCount = opts.maxCount ?? 500
  const searchObj: any = {}
  if (opts.before) searchObj.before = opts.before
  if (opts.after) searchObj.after = opts.after
  if (opts.unreadOnly) searchObj.unseen = true
  if (opts.fromContains) searchObj.from = opts.fromContains

  const mailbox = opts.mailbox ?? 'INBOX'
  const hasProtection = Array.isArray(opts.protectedSenders) && opts.protectedSenders.length > 0
  return withImap(async (client) => {
    const mb = await resolveMailbox(client, mailbox)
    await client.mailboxOpen(mb)
    const searchArg = Object.keys(searchObj).length === 0 ? true : searchObj
    const found = await client.search(searchArg, { uid: true })
    const matchedUids: number[] = Array.isArray(found) ? found : []
    if (matchedUids.length > maxCount) {
      throw new Error(`Matched ${matchedUids.length} messages, exceeds maxCount=${maxCount}. Refusing to bulk-trash.`)
    }
    const errors: { uid: number; error: string }[] = []
    let trashed = 0
    let protectedSkipped = 0
    const trashedUids: number[] = []
    for (const uid of matchedUids) {
      try {
        if (hasProtection) {
          const from = await fetchEnvelopeFrom(client, uid)
          if (isProtectedSender(from, opts.protectedSenders)) {
            protectedSkipped++
            continue
          }
        }
        await client.messageFlagsAdd(uid, ['\\Trash'])
        trashed++
        trashedUids.push(uid)
      } catch (e) {
        errors.push({ uid, error: (e as Error).message })
      }
    }
    return {
      matched: matchedUids.length,
      protected: protectedSkipped,
      trashed,
      uids: trashedUids,
      errors,
    }
  })
}

// Gmail IMAP SEARCH uses standard IMAP search criteria. We translate a simple
// query language (matches against from/subject/body) to IMAP OR-of-text search.
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
    // OR-combined text fields: any match qualifies
    const uids = await client.search({ or: [searchObj] }, { uid: true })
    if (!uids) return []
    const arr = Array.isArray(uids) ? uids : []
    if (arr.length === 0) return []
    return await fetchUids(client, mb, arr.slice(-limit).reverse(), !!opts.fetchBody)
  })
}

// === Mutations ===

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

// Archive = remove from \\Inbox. Gmail IMAP doesn't expose a true "archive"
// verb -- removing the \\Inbox label is the canonical way.
export const archive = (uid: string) =>
  setFlags(uid, 'INBOX', ['\\Inbox'], 'remove')

// Move to \\Trash (Gmail keeps the message in Trash for 30 days then deletes).
export const trash = (uid: string) =>
  setFlags(uid, 'INBOX', ['\\Trash'], 'add')

// === Sending ===

export interface SendInput {
  to: string | string[]
  subject: string
  text?: string
  html?: string
  cc?: string | string[]
  bcc?: string | string[]
  inReplyTo?: string  // Message-ID of the message being replied to
  references?: string // thread refs (RFC 5322)
}

export interface SendResult {
  messageId: string
  accepted: string[]
  rejected: string[]
}

export async function sendEmail(input: SendInput): Promise<SendResult> {
  const creds = loadCredentials()
  const transport = smtpTransport()
  const info = await transport.sendMail({
    from: creds.username,
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

// Reset cached state -- useful after rotating the app-specific password so
// the next call reloads from disk instead of holding the old one.
export function invalidateCredentialCache(): void {
  cachedCreds = null
  cachedTransport = null
}

// Quick connectivity probe used by the dashboard /api/gmail/status endpoint.
export interface StatusReport {
  ok: boolean
  imapReachable: boolean
  smtpConfigured: boolean
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
    const t = smtpTransport()
    await t.verify()
    smtpConfigured = true
  } catch (e) {
    if (!error) error = (e as Error).message
  }
  return {
    ok: imapReachable && smtpConfigured,
    imapReachable,
    smtpConfigured,
    user: loadCredentials().username,
    error,
  }
}

// Helper: keep this in case we need to regenerate credentials from a literal.
// Not auto-invoked -- expected to be called by a one-off setup script.
export function _writeCredentialsForSetup(username: string, password: string): void {
  if (!existsSync(CREDS_DIR)) mkdirSync(CREDS_DIR, { recursive: true, mode: 0o700 })
  const cleanPwd = password.replace(/\s+/g, '')
  writeFileSync(CREDS_PATH, JSON.stringify({ username, password: cleanPwd }, null, 2), { mode: 0o600 })
}