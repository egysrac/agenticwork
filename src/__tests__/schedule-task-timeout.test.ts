import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { computeSessionAmbiguity, decideTaskTimeout, resolveStuckTimeoutMs, TASK_FIRE_GRACE_MS, TASK_FIRE_TIMEOUT_MS } from '../web/schedule-runner.js'
import type { TaskInflightEntry } from '../web/schedule-runner.js'

// Tests for the post-fire timeout watchdog.
//
// The watchdog detects a scheduled task/heartbeat that was injected into a
// tmux session and is still running (session busy) past TASK_FIRE_TIMEOUT_MS.
// It closes the gap in the pending_task_retries path, which only triggers when
// a NEW task tries to inject into the already-busy session.
//
// decideTaskTimeout is pure (no I/O, no Map), so the decision logic is fully
// exercisable here without tmux mocks. The fix-revert test at the bottom
// guards against the test becoming a false guard.

const GRACE = TASK_FIRE_GRACE_MS   // 30_000
const TIMEOUT = TASK_FIRE_TIMEOUT_MS // 300_000
const MAX_TRACK = 6 * 60 * 60_000   // 6 hours

const BASE_OPTS = { graceMs: GRACE, timeoutMs: TIMEOUT, maxTrackMs: MAX_TRACK }

// sawTurn defaults to TRUE here: every pre-existing case in this file was
// written for a task that really did start running, and the watchdog's original
// contract (idle => done) is only correct for those. The sawTurn=false cases --
// an injection that never started a turn -- get their own describe block below.
function makeEntry(overrides: Partial<Pick<TaskInflightEntry, 'injectedAt' | 'alerted' | 'sawTurn'>> = {}): Pick<TaskInflightEntry, 'injectedAt' | 'alerted' | 'sawTurn'> {
  return { injectedAt: 0, alerted: false, sawTurn: true, ...overrides }
}

// --- Grace period ---

describe('decideTaskTimeout: grace period', () => {
  it('holds during the grace window even when the pane is busy', () => {
    const entry = makeEntry({ injectedAt: 1000 })
    const now = 1000 + GRACE - 1
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('hold')
  })

  it('holds at exactly the grace boundary (< timeout)', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = GRACE
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('hold')
  })
})

// --- Idle clear ---

describe('decideTaskTimeout: idle clear', () => {
  it('clears immediately when the pane is idle (task completed before timeout)', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = GRACE + 1000
    expect(decideTaskTimeout(entry, 'idle', now, BASE_OPTS)).toBe('clear')
  })

  it('clears even before the grace period if somehow idle', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = GRACE - 5000
    expect(decideTaskTimeout(entry, 'idle', now, BASE_OPTS)).toBe('clear')
  })

  it('clears when idle even after the timeout has elapsed', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = TIMEOUT + 1000
    expect(decideTaskTimeout(entry, 'idle', now, BASE_OPTS)).toBe('clear')
  })
})

// --- Timeout alert (the load-bearing case) ---

describe('decideTaskTimeout: timeout alert', () => {
  it('alerts when the session is still busy past the timeout threshold', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = TIMEOUT + 1
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('alert')
  })

  it('alerts at a much later elapsed time if still busy', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = TIMEOUT * 3
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('alert')
  })

  it('holds when elapsed is exactly one ms below the timeout', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = TIMEOUT - 1
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('hold')
  })
})

// --- Already alerted (one-shot) ---

describe('decideTaskTimeout: one-shot alert flag', () => {
  it('holds after the first alert has been sent (no repeat alerts)', () => {
    const entry = makeEntry({ injectedAt: 0, alerted: true })
    const now = TIMEOUT + 60_000
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('hold')
  })

  it('still clears when idle even after alerted', () => {
    const entry = makeEntry({ injectedAt: 0, alerted: true })
    const now = TIMEOUT + 60_000
    expect(decideTaskTimeout(entry, 'idle', now, BASE_OPTS)).toBe('clear')
  })
})

// --- Lost injection (idle pane that never started a turn) ---
//
// Regression guard for the 2026-08-23 silent loss: two heartbeats were injected
// into a session wedged at 100% context, which presents as a perfectly normal
// idle pane. The watchdog cleared them on the next sweep as "completed", the
// runner had already stamped lastRun, and nothing ever retried them.

describe('decideTaskTimeout: injection that never started a turn', () => {
  it('reports lost when the pane is idle past grace and no turn was ever observed', () => {
    const entry = makeEntry({ injectedAt: 0, sawTurn: false })
    const now = GRACE + 1
    expect(decideTaskTimeout(entry, 'idle', now, BASE_OPTS)).toBe('lost')
  })

  it('holds inside the grace window -- pre-turn lag is not a loss', () => {
    const entry = makeEntry({ injectedAt: 0, sawTurn: false })
    const now = GRACE - 1
    expect(decideTaskTimeout(entry, 'idle', now, BASE_OPTS)).toBe('hold')
  })

  it('clears instead of losing once a turn has been observed', () => {
    const entry = makeEntry({ injectedAt: 0, sawTurn: true })
    const now = GRACE + 1
    expect(decideTaskTimeout(entry, 'idle', now, BASE_OPTS)).toBe('clear')
  })

  it('still evicts at max tracking age rather than reporting lost', () => {
    const entry = makeEntry({ injectedAt: 0, sawTurn: false })
    const now = MAX_TRACK + 1
    expect(decideTaskTimeout(entry, 'idle', now, BASE_OPTS)).toBe('clear')
  })

  it('does not report lost while the pane is busy -- that is the alert path', () => {
    const entry = makeEntry({ injectedAt: 0, sawTurn: false })
    const now = TIMEOUT + 1
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('alert')
  })
})

// --- LEDGERLIVE907: grace window must survive the swallowed-Enter recovery
// chain on a busy shared session ---
//
// 2026-09-07: ledger-live-drain (a */2 * * * * heartbeat sharing the busy
// jarvis-channels session with other scheduled tasks) was flipping between
// 'fired' and 'lost' roughly every 30s instead of its real 2-minute cadence.
// Two live measurements from the production task_runs log / dashboard.log:
//   - a 'lost' fired at elapsedMs:30002 -- the pane had gone idle and sawTurn
//     was still false at almost exactly the OLD 30_000ms grace boundary.
//   - a follow-up retry's prompt was observed landing in the session
//     transcript 28.6s after its own "Scheduled task fired" log line -- 1.3s
//     under the old grace, so even retries kept re-tripping the same wire.
// The post-send resubmit chain (setTimeout(resubmit, 2000), then up to
// RESUBMIT_MAX_ATTEMPTS more attempts 3s apart) exists precisely to recover a
// swallowed Enter, but its worst case (~17s) plus the agent's own turn time
// (10-30s observed for a trivial heartbeat once picked up) routinely exceeded
// 30s end to end. This block pins the grace window at a value that comfortably
// covers that combined worst case, so a fix that quietly shrinks it back down
// regresses the exact bug this suite exists to catch.
describe('decideTaskTimeout: LEDGERLIVE907 -- grace window covers the resubmit chain', () => {
  it('holds (does not report lost) at 28.6s elapsed -- the measured production near-miss', () => {
    const entry = makeEntry({ injectedAt: 0, sawTurn: false })
    const now = 28_667
    expect(decideTaskTimeout(entry, 'idle', now, BASE_OPTS)).toBe('hold')
  })

  it('holds at the old 30s boundary that used to report lost', () => {
    const entry = makeEntry({ injectedAt: 0, sawTurn: false })
    const now = 30_002
    expect(decideTaskTimeout(entry, 'idle', now, BASE_OPTS)).toBe('hold')
  })

  it('the grace constant itself is at least 60s (fix-revert guard)', () => {
    // A future edit that quietly lowers TASK_FIRE_GRACE_MS back toward 30s
    // would pass every other test in this file (they all parametrise off the
    // imported constant) while silently reintroducing the LEDGERLIVE907 loop.
    // Pin the floor explicitly.
    expect(GRACE).toBeGreaterThanOrEqual(60_000)
  })

  it('injectedAt is stamped fresh at registration time, not reused from the tick-start clock (fix-revert guard)', () => {
    // The stale-timestamp half of the fix: entry.injectedAt used to be the
    // `now` captured once at the top of runCheck(), before
    // isSessionReadyForPrompt's wait and sendPromptToSession's own pre-flight
    // wait-until-idle (up to 12s) + chunked send had run -- silently charging
    // that elapsed time against the grace window before the prompt had even
    // landed. It must be a fresh Date.now() taken right when the in-flight
    // entry is registered.
    const src = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
    expect(src).toMatch(/const injectedAt = Date\.now\(\)/)
    expect(src).toMatch(/scheduleLastRun\.set\(task\.name, injectedAt\)/)
    expect(src).toMatch(/scheduleLastRun\.get\(entry\.taskName\) === entry\.injectedAt/)
  })
})

// --- Non-busy pane states ---

describe('decideTaskTimeout: non-busy pane states hold (owned by other watchdogs)', () => {
  const pastTimeout = TIMEOUT + 1000

  it('holds on unknown (session may be restarting)', () => {
    expect(decideTaskTimeout(makeEntry(), 'unknown', pastTimeout, BASE_OPTS)).toBe('hold')
  })

  it('holds on null capture (no signal -- be conservative)', () => {
    expect(decideTaskTimeout(makeEntry(), null, pastTimeout, BASE_OPTS)).toBe('hold')
  })

  it('holds on error (thinking-block API error -- channel-monitor owns that)', () => {
    expect(decideTaskTimeout(makeEntry(), 'error', pastTimeout, BASE_OPTS)).toBe('hold')
  })

  it('holds on typing (post-send resubmit loop is active)', () => {
    expect(decideTaskTimeout(makeEntry(), 'typing', pastTimeout, BASE_OPTS)).toBe('hold')
  })
})

// --- Max track age eviction ---

describe('decideTaskTimeout: max tracking age', () => {
  it('evicts the entry regardless of pane state after maxTrackMs', () => {
    const entry = makeEntry({ injectedAt: 0, alerted: true })
    const now = MAX_TRACK + 1
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('clear')
  })

  it('evicts even if the pane is unknown at max age', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = MAX_TRACK + 1
    expect(decideTaskTimeout(entry, 'unknown', now, BASE_OPTS)).toBe('clear')
  })
})

// --- Fix-revert guard ---
//
// This test verifies the test is a REAL guard: if the 'alert' case were
// removed from decideTaskTimeout (returning 'hold' for all busy states),
// the test below would turn RED. A test that stays green after the fix is
// reverted is a false guard and must be discarded.
//
// How to verify: temporarily change decideTaskTimeout so it never returns
// 'alert' (comment out the `if (paneState === 'busy' && elapsed >= ...) return 'alert'`
// line) and confirm this test fails.

describe('fix-revert guard: alert case is load-bearing', () => {
  it('returns alert for a busy session past the threshold -- proves the alert branch fires', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const result = decideTaskTimeout(entry, 'busy', TIMEOUT + 1, BASE_OPTS)
    // If the fix (the alert branch) were removed, result would be 'hold' and
    // this assertion would fail: that is the correct behaviour.
    expect(result).toBe('alert')
    expect(result).not.toBe('hold')
  })
})

// --- HERMES223C: shared-pane task attribution ---
//
// 2026-09-09 21:09:29 (kanban 223c45c8 comment #107): ledger-live-drain and
// reggeli-napindito both fired their own "possible hang" alert off the SAME
// busy jarvis-channels pane within seconds of each other. taskInflightMap is
// keyed by `${task}@${agent}`, not by session, so two tasks sharing one tmux
// session get two independent entries watching one physical pane -- neither
// can tell which of them the busy state actually belongs to.
//
// Hermes's explicit caution: do not just raise the threshold, that only
// delays the same misattribution -- handle the attribution with real
// execution evidence. The evidence used here: a prompt is only injected into
// a session that read ready at injection time (a busy session gets queued to
// pending_task_retries instead). So a later injectedAt on the same session is
// proof the session went ready again after the earlier entry's turn, meaning
// the earlier ("shadowed") entry can no longer claim credit/blame for a busy
// pane observed afterward.

describe('computeSessionAmbiguity: identifies shadowed entries on a shared session', () => {
  it('marks the older entry as shadowed when a newer entry shares its session', () => {
    const entries: Array<[string, { session: string; injectedAt: number }]> = [
      ['ledger-live-drain@jarvis', { session: 'jarvis-channels', injectedAt: 1000 }],
      ['reggeli-napindito@jarvis', { session: 'jarvis-channels', injectedAt: 5000 }],
    ]
    const shadowed = computeSessionAmbiguity(entries)
    expect(shadowed.has('ledger-live-drain@jarvis')).toBe(true)
    expect(shadowed.has('reggeli-napindito@jarvis')).toBe(false)
  })

  it('marks nobody shadowed when each task has its own session', () => {
    const entries: Array<[string, { session: string; injectedAt: number }]> = [
      ['task-a@jarvis', { session: 'jarvis-channels', injectedAt: 1000 }],
      ['task-b@jarvis', { session: 'jarvis-worker', injectedAt: 5000 }],
    ]
    expect(computeSessionAmbiguity(entries).size).toBe(0)
  })

  it('marks nobody shadowed for a single entry on its session', () => {
    const entries: Array<[string, { session: string; injectedAt: number }]> = [
      ['task-a@jarvis', { session: 'jarvis-channels', injectedAt: 1000 }],
    ]
    expect(computeSessionAmbiguity(entries).size).toBe(0)
  })

  it('with three entries on one session, only the newest keeps the session -- the other two are shadowed', () => {
    const entries: Array<[string, { session: string; injectedAt: number }]> = [
      ['a@jarvis', { session: 'jarvis-channels', injectedAt: 1000 }],
      ['b@jarvis', { session: 'jarvis-channels', injectedAt: 2000 }],
      ['c@jarvis', { session: 'jarvis-channels', injectedAt: 3000 }],
    ]
    const shadowed = computeSessionAmbiguity(entries)
    expect(shadowed.has('a@jarvis')).toBe(true)
    expect(shadowed.has('b@jarvis')).toBe(true)
    expect(shadowed.has('c@jarvis')).toBe(false)
  })
})

describe('decideTaskTimeout: sessionShadowed suppresses the busy-alert for the older entry', () => {
  it('holds instead of alerting when sessionShadowed is true, even past the timeout', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = TIMEOUT + 1
    expect(decideTaskTimeout(entry, 'busy', now, { ...BASE_OPTS, sessionShadowed: true })).toBe('hold')
  })

  it('still alerts normally when sessionShadowed is false (unshared session, unaffected)', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = TIMEOUT + 1
    expect(decideTaskTimeout(entry, 'busy', now, { ...BASE_OPTS, sessionShadowed: false })).toBe('alert')
  })

  it('still alerts normally when sessionShadowed is omitted (default behaviour unchanged)', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const now = TIMEOUT + 1
    expect(decideTaskTimeout(entry, 'busy', now, BASE_OPTS)).toBe('alert')
  })

  it('a shadowed entry can still be lost on idle -- shadowing only guards the busy-alert path', () => {
    const entry = makeEntry({ injectedAt: 0, sawTurn: false })
    const now = GRACE + 1
    expect(decideTaskTimeout(entry, 'idle', now, { ...BASE_OPTS, sessionShadowed: true })).toBe('lost')
  })

  it('fix-revert guard: if sessionShadowed were ignored, this would incorrectly read alert', () => {
    const entry = makeEntry({ injectedAt: 0 })
    const result = decideTaskTimeout(entry, 'busy', TIMEOUT + 1, { ...BASE_OPTS, sessionShadowed: true })
    expect(result).toBe('hold')
    expect(result).not.toBe('alert')
  })
})

describe('HERMES223C fix-revert guard: the sweep wires session-sharing evidence through', () => {
  it('the watchdog snapshots ambiguity once per tick and passes it into decideTaskTimeout', () => {
    const src = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
    expect(src).toMatch(/const sessionShadowedKeys = computeSessionAmbiguity\(taskInflightMap\)/)
    expect(src).toMatch(/sessionShadowed: sessionShadowedKeys\.has\(key\),/)
  })
})

// --- Per-task stuck threshold ---
//
// TASK_FIRE_TIMEOUT_MS is one global number. It is the right default for the
// common case (a short-cadence heartbeat still busy after 5 minutes IS a real
// signal) and wrong for a task whose whole job is to think for a while: a
// nightly analysis run was declared a "possible hang" five minutes in, on
// 2026-07-30 at 02:12, and finished normally at 02:18. The operator got a
// false alarm about a task doing exactly what it was written to do.
describe('resolveStuckTimeoutMs: the threshold is per task', () => {
  const MIN = 60_000

  it('falls back to the global default when unset', () => {
    expect(resolveStuckTimeoutMs({})).toBe(TASK_FIRE_TIMEOUT_MS)
  })

  it('honours an explicit longer budget (the nightly analysis case)', () => {
    expect(resolveStuckTimeoutMs({ stuckAfterMinutes: 20 })).toBe(20 * MIN)
  })

  it('a malformed or non-positive value falls back to the default, never to NaN', () => {
    expect(resolveStuckTimeoutMs({ stuckAfterMinutes: NaN })).toBe(TASK_FIRE_TIMEOUT_MS)
    expect(resolveStuckTimeoutMs({ stuckAfterMinutes: 0 })).toBe(TASK_FIRE_TIMEOUT_MS)
    expect(resolveStuckTimeoutMs({ stuckAfterMinutes: -5 })).toBe(TASK_FIRE_TIMEOUT_MS)
    expect(resolveStuckTimeoutMs({ stuckAfterMinutes: 'twenty' as unknown as number })).toBe(TASK_FIRE_TIMEOUT_MS)
  })

  it('clamps below one minute so the alert cannot fire inside startup noise', () => {
    expect(resolveStuckTimeoutMs({ stuckAfterMinutes: 0.1 })).toBe(MIN)
  })

  it('clamps to the tracking window, so a huge value cannot silently disable the alert', () => {
    // Entries are evicted at maxTrackMs regardless, so anything above it would
    // mean "never alert" while still looking like a threshold.
    expect(resolveStuckTimeoutMs({ stuckAfterMinutes: 60 * 24 })).toBe(MAX_TRACK)
  })

  it('the resolved budget actually drives the decision', () => {
    const at6min = 6 * MIN
    const opts = { graceMs: GRACE, maxTrackMs: MAX_TRACK }
    // Both budgets are stated EXPLICITLY rather than leaning on the global
    // default. The claim under test is "the resolved budget drives the
    // decision", which says nothing about what the default happens to be --
    // and the default is install-configurable (TASK_STALL_TIMEOUT_MS), so an
    // install that raises it to 10 minutes would have failed this test on a
    // point it never meant to assert.
    // 5-minute budget: 6 minutes of continuous busy is a hang.
    expect(decideTaskTimeout(makeEntry(), 'busy', at6min, { ...opts, timeoutMs: resolveStuckTimeoutMs({ stuckAfterMinutes: 5 }) })).toBe('alert')
    // 20-minute budget: the same 6 minutes is just work in progress.
    expect(decideTaskTimeout(makeEntry(), 'busy', at6min, { ...opts, timeoutMs: resolveStuckTimeoutMs({ stuckAfterMinutes: 20 }) })).toBe('hold')
  })

  it('the sweep uses the entry budget, not the global constant (fix-revert guard)', () => {
    const src = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
    expect(src).toMatch(/timeoutMs: entry\.timeoutMs,/)
    expect(src).toMatch(/const timeoutMs = resolveStuckTimeoutMs\(task\)/)
  })
})
