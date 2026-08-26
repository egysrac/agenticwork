// Gmail cleanup runner -- weekly auto-trash of unread messages older than
// 14 days, with a Tier 1 protected-sender allowlist that is NEVER touched.
//
// Why a Node-level runner and not a /api/schedules entry:
//   - Does not depend on the Jarvis tmux session being alive (a /api/schedules
//     task is fired by the schedule-runner polling in tmux)
//   - Does not wake Jarvis or send a Telegram notification -- silent (info-level
//     logger entries only)
//   - Has direct access to the Gmail credentials -- no Bearer-token round-trip
//
// Fail-closed: if the tier1 config file is missing or malformed, cleanup is
// SKIPPED entirely (we never trash without an explicit allowlist). This is the
// safer default vs. "trash everything and assume no protected" -- a missing
// config means we can't prove Alex wants those senders trashed.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CronExpressionParser } from 'cron-parser'
import { bulkTrash } from '../gmail-api.js'
import { STORE_DIR, APP_TZ } from '../config.js'
import { logger } from '../logger.js'

// Friday 02:57 local time. Off the :00 minute so it does not collide with
// every other cron that fires on the hour across the fleet.
const CRON = '57 2 * * 5'
const BEFORE_DAYS = 14
// Hard safety cap: refuse to trash more than this in a single run. The current
// backlog is ~13k so 15k is enough headroom; a future explosion is rejected
// with a loud error rather than nuking the user's mailbox.
const MAX_COUNT = 15000

const TIER1_PATH = join(STORE_DIR, '.gmail-tier1.json')

interface ProtectedConfig {
  // Tier 1: SOHA ne töröld -- valódi személyes feladók (igazi emberek)
  domains?: string[]     // e.g. "gmail.com" -> any @gmail.com is protected
  addresses?: string[]   // e.g. "alice@gmail.com" -> exact address only
  // Tier 2: fizetendő számla küldők -- CSAK manuálisan töröld, miután megjött
  // a sikeres fizetési értesítő (pl. Revolut/IBKR push vagy banki confirm)
  waitlist_domains?: string[]
}

let stopFlag = false
let currentTimeout: NodeJS.Timeout | null = null

function loadProtected(): string[] | null {
  if (!existsSync(TIER1_PATH)) {
    logger.info(
      { path: TIER1_PATH },
      'Gmail cleanup: protected config missing, skipping this run (fail-closed)'
    )
    return null
  }
  try {
    const raw = readFileSync(TIER1_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as ProtectedConfig
    const list: string[] = []
    // Tier 1: valódi személyes feladók
    if (Array.isArray(parsed.domains)) {
      for (const d of parsed.domains) {
        if (typeof d === 'string' && d.trim()) list.push(d.trim())
      }
    }
    if (Array.isArray(parsed.addresses)) {
      for (const a of parsed.addresses) {
        if (typeof a === 'string' && a.trim()) list.push(a.trim())
      }
    }
    // Tier 2: fizetendő számla küldők (manuálisan törlendők fizetés után)
    if (Array.isArray(parsed.waitlist_domains)) {
      for (const d of parsed.waitlist_domains) {
        if (typeof d === 'string' && d.trim()) list.push(d.trim())
      }
    }
    if (list.length === 0) {
      logger.warn({ path: TIER1_PATH }, 'Gmail cleanup: protected config has no entries, skipping this run')
      return null
    }
    logger.info(
      {
        tier1_domains: Array.isArray(parsed.domains) ? parsed.domains.length : 0,
        tier1_addresses: Array.isArray(parsed.addresses) ? parsed.addresses.length : 0,
        tier2_waitlist: Array.isArray(parsed.waitlist_domains) ? parsed.waitlist_domains.length : 0,
      },
      'Gmail cleanup: loaded protected senders'
    )
    return list
  } catch (err) {
    logger.warn({ err, path: TIER1_PATH }, 'Gmail cleanup: protected config malformed, skipping this run')
    return null
  }
}

function msUntilNextCron(): number {
  // cron-parser uses the configured APP_TZ so the schedule fires in
  // Europe/Budapest local time regardless of the host TZ.
  const interval = CronExpressionParser.parse(CRON, { tz: APP_TZ })
  const next = interval.next().toDate()
  return Math.max(next.getTime() - Date.now(), 1000)
}

async function runCleanup(): Promise<void> {
  const protectedSenders = loadProtected()
  if (!protectedSenders) return  // Fail-closed: no allowlist, no cleanup

  const before = new Date(Date.now() - BEFORE_DAYS * 24 * 60 * 60 * 1000)
  try {
    const result = await bulkTrash({
      before,
      unreadOnly: true,
      maxCount: MAX_COUNT,
      protectedSenders,
    })
    logger.info(
      {
        matched: result.matched,
        protected: result.protected,
        trashed: result.trashed,
        errors: result.errors.length,
        sample_errors: result.errors.slice(0, 3),
      },
      `Gmail cleanup done: trashed ${result.trashed} unread >${BEFORE_DAYS}d, ${result.protected} protected (tier1 + tier2)`
    )
  } catch (err) {
    logger.error({ err }, 'Gmail cleanup: bulkTrash failed')
  }
}

function scheduleNext(): void {
  if (stopFlag) return
  const delay = msUntilNextCron()
  const nextRun = new Date(Date.now() + delay)
  logger.info(
    { cron: CRON, nextRun: nextRun.toISOString() },
    `Gmail cleanup scheduled for ${nextRun.toLocaleString('hu-HU', { timeZone: APP_TZ })}`
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