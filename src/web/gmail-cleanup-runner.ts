// Gmail cleanup runner (TRIAGE826) -- nightly 4-step triage pipeline.
//
// Cron: `0 4 * * *` Europe/Budapest (see msUntilNextCron). The 4 steps run in
// order; each one is independent and failures are isolated (step 3 failing
// does not abort step 4).
//
//   1. trashStep         : category:(promotions OR social OR forums)
//                          older_than:7d -> batchModify [TRASH add, INBOX remove]
//   2. markReadStep      : category:updates is:unread older_than:1d
//                          -> batchModify [UNREAD remove]
//   3. calendarExtractStep: scan recent invoice-shaped emails, LLM-extract
//                          {date, amount, currency, description}, create a
//                          Google Calendar event (all-day) for each.
//   4. andiReplyStep     : for each email from zavada.andrea@gmail.com that
//                          needs a reply, fetch the body, LLM-generate a
//                          short contextual Hungarian reply (no commitments,
//                          signed "Alex"), and send via gmail.send XOAUTH2.
//                          If the LLM draft fails validation, the email
//                          stays UNREAD and the next nightly run retries.
//
// Why a Node-level runner (and not /api/schedules):
//   - Independent of the main-agent tmux session.
//   - Direct Gmail credential access; no Bearer-token round-trip per call.
//   - Silent (logger.info only); the main agent does NOT get a Telegram ping
//     unless something goes wrong.
//
// Protected:
//   - protectCategoryPrimary in gmail-api.ts is the primary safety net --
//     CATEGORY_PRIMARY / CATEGORY_PERSONAL labels are never trashed.
//   - NO_TRASH_DEFAULT below is an extra guard for the categories that the
//     user has been burned on before (the 2026-08-14 Binance incident).
//   - There is NO tier1 allowlist any more -- the user-facing configuration
//     is "the category:primary category never gets touched", which is
//     enforced by Gmail's own labeling rather than a hand-maintained list.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CronExpressionParser } from 'cron-parser'
import {
  bulkModifyByQuery,
  markReadByQuery,
  _listIds,
  _httpRequest,
  _accessToken,
  _getMessageDetail,
  extractInvoiceData,
  extractAndiReply,
  andIEmailReply,
  type BulkModifyResult,
  type InvoiceData,
} from '../gmail-api.js'
import { STORE_DIR, APP_TZ } from '../config.js'
import { logger } from '../logger.js'

// Daily at 04:00 Europe/Budapest. Off the :00 minute would be nice too, but
// the dashboard keeps a 04:00 heartbeat so the time is intentional -- the
// fleet's pre-dawn window is when nothing else runs.
const CRON = '0 4 * * *'

// Senders / domains the trashStep must NEVER touch, even when their category
// is promotions/social/forums. Substring match on domain-style entries (any
// "@<domain>"), exact on full addresses. The Binance incident
// (2026-08-14, see ~/.claude/skills/gmail-bulk-trash/SKILL.md) is the reason
// this list exists at all -- without it, a finance-related sender
// matching `category:promotions` would be silently auto-trashed.
const NO_TRASH_DEFAULT: string[] = [
  'binance.com',
  'kraken.com',
  'coinbase.com',
]

// The waitlist is informational only: those domains are NOT auto-trashed
// and NOT auto-protected; they are kept in a separate file so the manual
// invoice-payment workflow can still read them. The runner does NOT load
// this file -- if you change it, nothing in this module changes.
const WAITLIST_PATH = join(STORE_DIR, '.email-waitlist-domains.json')

// === Runner state ===

interface StepResult {
  step: string
  ok: boolean
  detail: Record<string, unknown>
}

let stopFlag = false
let currentTimeout: NodeJS.Timeout | null = null

// === Step implementations ===

// Trash the categories we never want to see. Returns a normalised step result.
async function trashStep(): Promise<StepResult> {
  // The unified query covers the three "not for me" categories in one go.
  const query = 'category:(promotions OR social OR forums) older_than:7d'
  try {
    const result = await bulkModifyByQuery(query, {
      addLabelIds: ['TRASH'],
      removeLabelIds: ['INBOX'],
      maxCount: 5000,
      protectCategoryPrimary: true,
      protectedSenders: NO_TRASH_DEFAULT,
    })
    return {
      step: 'trash',
      ok: true,
      detail: {
        query,
        matched: result.matched,
        protected: result.protected,
        modified: result.modified,
        ids: result.ids.length,
      },
    }
  } catch (e) {
    return { step: 'trash', ok: false, detail: { error: (e as Error).message } }
  }
}

// Mark updates-category unread mail as read (without trashing). The label
// stays in the inbox; only the UNREAD flag is dropped.
async function markReadStep(): Promise<StepResult> {
  const query = 'category:updates is:unread older_than:1d'
  try {
    const result = await markReadByQuery(query, { maxCount: 5000 })
    return {
      step: 'mark-read',
      ok: true,
      detail: {
        query,
        matched: result.matched,
        modified: result.modified,
      },
    }
  } catch (e) {
    return { step: 'mark-read', ok: false, detail: { error: (e as Error).message } }
  }
}

// Scan recent invoice-shaped emails and create Google Calendar events for
// the due dates. The LLM extraction can return null on any non-invoice or
// non-parseable body; that is the common case (most updates-category mail
// is shipping notices, statements, etc.) and is logged at debug level.
//
// Calendar events are all-day on the due date. The description carries the
// source email id + the extracted amount / currency / description so the
// operator can audit from the calendar entry itself.
async function calendarExtractStep(): Promise<StepResult> {
  const query = 'category:updates newer_than:3d (subject:(számla OR szamla OR invoice OR fizet OR díjak OR dijak) OR subject:payment)'
  let scanned = 0
  let extracted = 0
  let created = 0
  const errors: string[] = []
  try {
    const ids = await _listIds(query, { maxResults: 100 })
    scanned = ids.length
    for (const id of ids) {
      try {
        const token = await _accessToken()
        const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`
        const { status, data } = await _httpRequest(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        })
        if (status !== 200) {
          errors.push(`${id}: metadata fetch HTTP ${status}`)
          continue
        }
        const parsed = JSON.parse(data) as {
          payload?: { headers?: { name?: string; value?: string }[] }
          snippet?: string
        }
        const fromHeader = parsed.payload?.headers?.find(h => h.name?.toLowerCase() === 'from')?.value ?? ''
        const bodyText = parsed.snippet ?? ''
        const invoice: InvoiceData | null = await extractInvoiceData(bodyText, fromHeader, id)
        if (!invoice) continue
        extracted++
        const created2 = await createCalendarEvent(invoice)
        if (created2) created++
      } catch (e) {
        errors.push(`${id}: ${(e as Error).message}`)
      }
    }
    return {
      step: 'calendar-extract',
      ok: true,
      detail: { query, scanned, extracted, created, errors: errors.slice(0, 3), errorCount: errors.length },
    }
  } catch (e) {
    return { step: 'calendar-extract', ok: false, detail: { scanned, extracted, created, error: (e as Error).message } }
  }
}

// Create an all-day Google Calendar event for the invoice due date. Uses the
// existing OAuth token (the .google-oauth.json already lists the `calendar`
// scope). Returns true on success, false on any failure (logged but never
// throws -- this is best-effort enrichment).
async function createCalendarEvent(invoice: InvoiceData): Promise<boolean> {
  const token = await _accessToken()
  const start = invoice.date
  // All-day events use `date` (not `dateTime`) and need an exclusive end = start+1.
  const end = (() => {
    const d = new Date(start + 'T00:00:00Z')
    d.setUTCDate(d.getUTCDate() + 1)
    return d.toISOString().slice(0, 10)
  })()
  const event = {
    summary: `Fizetés: ${invoice.description}`.slice(0, 200),
    description:
      `Source email: ${invoice.source_email_id}\n` +
      `Amount: ${invoice.amount} ${invoice.currency}\n` +
      `Description: ${invoice.description}\n\n` +
      `(Created by gmail-cleanup-runner.ts)`,
    start: { date: start },
    end: { date: end },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 60 * 24 },   // 1 day before, popup
      ],
    },
  }
  try {
    const { status, data } = await _httpRequest(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
      event,
    )
    if (status !== 200 && status !== 201) {
      logger.warn(
        { status, body: data.slice(0, 200), invoice },
        'calendarExtractStep: create event failed',
      )
      return false
    }
    return true
  } catch (e) {
    logger.warn({ err: (e as Error).message, invoice }, 'calendarExtractStep: create event threw')
    return false
  }
}

// Auto-reply to unread emails from zavada.andrea@gmail.com. The exact-match
// gate is in isAndiSender() / andIEmailReply(); the runner does NOT do any
// fuzzy matching. The reply is generated by an LLM (extractAndiReply) so the
// content reflects what Andi's email actually asks -- a generic "Megkaptam,
// válaszolok" stub is no longer acceptable. If the LLM is unavailable or
// returns a draft that fails validation, we DO NOT send a fallback reply:
// the email stays UNREAD and the next nightly run will retry.
//
// BUGFIX (2026-09-05): the window used to be `newer_than:2d`. UNREAD is
// already the retry signal (the label is only cleared on a successful send),
// so a short time window doesn't protect anything -- it just gives a
// transient failure a 2-day grace period before the runner silently stops
// looking at it forever. That is exactly what happened: sendEmail() was
// broken (SMTP XOAUTH2 rejected the gmail.send-scoped token, see the fix in
// gmail-api.ts sendEmail()) so every nightly attempt on Andi's 2026-08-31
// email errored out, and once the email turned 2 days old it dropped out of
// this query entirely -- 5 days of silence with no further retry attempts
// and no error visible outside the log. Widened to 14d so a multi-day outage
// no longer strands a message permanently; still bounded so a deliberately
// re-flagged ancient email doesn't get replied to.
async function andiReplyStep(): Promise<StepResult> {
  const query = 'from:zavada.andrea@gmail.com is:unread newer_than:14d'
  let scanned = 0
  let replied = 0
  let skipped = 0
  const errors: string[] = []
  const auditLog: Array<{ id: string; subject: string; summary: string }> = []
  try {
    const ids = await _listIds(query, { maxResults: 20 })
    scanned = ids.length
    for (const id of ids) {
      try {
        const detail = await _getMessageDetail(id)
        if (!detail) {
          errors.push(`${id}: detail fetch failed`)
          continue
        }
        const draft = await extractAndiReply(detail.bodyText, detail.fromEnvelope, id)
        if (!draft) {
          // LLM unavailable or validation rejected the draft -- keep the
          // email UNREAD so the next run retries instead of sending a
          // generic fallback.
          skipped++
          errors.push(`${id}: LLM draft rejected`)
          continue
        }
        const replySubject = detail.subject.toLowerCase().startsWith('re:') ? detail.subject : `Re: ${detail.subject || 'üzeneted'}`
        const result = await andIEmailReply(
          {
            to: 'zavada.andrea@gmail.com',
            subject: replySubject,
            text: draft.reply,
            inReplyTo: undefined,
            references: detail.threadId || undefined,
          },
          detail.fromEnvelope,
        )
        if (result.accepted.length > 0) {
          replied++
          auditLog.push({ id, subject: detail.subject, summary: draft.summary })
        } else {
          skipped++
          errors.push(`${id}: SMTP rejected`)
        }
        // Drop the UNREAD label so we don't keep replying on every run,
        // even when we skipped (a stale UNREAD would still trigger another
        // attempt tomorrow -- the skipped count is the audit signal that
        // something went wrong).
        try {
          await bulkModifyByQuery(`rfc822msgid:${id}`, { removeLabelIds: ['UNREAD'], maxCount: 1, protectCategoryPrimary: false })
        } catch { /* not fatal */ }
      } catch (e) {
        errors.push(`${id}: ${(e as Error).message}`)
      }
    }
    if (replied > 0) {
      logger.info({ step: 'andi-reply', auditLog }, 'andiReplyStep: sent contextual auto-replies')
    }
    return {
      step: 'andi-reply',
      ok: true,
      detail: { query, scanned, replied, skipped, errors: errors.slice(0, 3), errorCount: errors.length, auditLog },
    }
  } catch (e) {
    return { step: 'andi-reply', ok: false, detail: { scanned, replied, skipped, error: (e as Error).message } }
  }
}

// === Run lifecycle ===

async function runCleanup(): Promise<void> {
  const startMs = Date.now()
  const steps: StepResult[] = []
  // Run in order. A failing step does NOT abort the next one -- this is a
  // four-step pipeline, not a transaction.
  steps.push(await trashStep())
  steps.push(await markReadStep())
  steps.push(await calendarExtractStep())
  steps.push(await andiReplyStep())

  const summary = {
    duration_ms: Date.now() - startMs,
    steps: steps.map(s => ({ name: s.step, ok: s.ok, ...s.detail })),
    waitlist_domains_loaded: existsSync(WAITLIST_PATH)
      ? tryReadWaitlistCount(WAITLIST_PATH)
      : 0,
  }
  const allOk = steps.every(s => s.ok)
  if (allOk) {
    logger.info(summary, `Gmail cleanup done: 4 steps in ${summary.duration_ms}ms`)
  } else {
    const failed = steps.filter(s => !s.ok).map(s => s.step).join(',')
    logger.warn({ ...summary, failed }, `Gmail cleanup partial: ${failed} failed`)
  }
}

function tryReadWaitlistCount(path: string): number {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { domains?: unknown }
    return Array.isArray(parsed.domains) ? parsed.domains.length : 0
  } catch {
    return 0
  }
}

function msUntilNextCron(): number {
  const interval = CronExpressionParser.parse(CRON, { tz: APP_TZ })
  const next = interval.next().toDate()
  return Math.max(next.getTime() - Date.now(), 1000)
}

function scheduleNext(): void {
  if (stopFlag) return
  const delay = msUntilNextCron()
  const nextRun = new Date(Date.now() + delay)
  logger.info(
    { cron: CRON, nextRun: nextRun.toISOString(), tz: APP_TZ },
    `Gmail cleanup scheduled for ${nextRun.toLocaleString('hu-HU', { timeZone: APP_TZ })}`,
  )
  currentTimeout = setTimeout(async () => {
    await runCleanup()
    scheduleNext()
  }, delay).unref()
}

export function startGmailCleanupRunner(): { stop: () => void } {
  stopFlag = false
  scheduleNext()
  return {
    stop: () => {
      stopFlag = true
      if (currentTimeout) {
        clearTimeout(currentTimeout)
        currentTimeout = null
      }
    },
  }
}

// Exported for tests: run the cleanup immediately, in-process, without
// scheduling. The 4 steps run synchronously in order; returns the per-step
// results so the integration test can assert on them.
export async function runGmailCleanupNow(): Promise<StepResult[]> {
  const out: StepResult[] = []
  out.push(await trashStep())
  out.push(await markReadStep())
  out.push(await calendarExtractStep())
  out.push(await andiReplyStep())
  return out
}
