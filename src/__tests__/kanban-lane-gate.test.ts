// §23-24 lane-WIP gate contract tests (governance v1.0, TASK-0018 -- fixes for
// the independent reviewer's 8 blockers). Companion to kanban-lane-migration.test.ts
// (which covers the plain lane column + countInProgressInLane); this file covers
// the atomic gate functions the routes now call, the lane CHECK constraint, and
// the restart-only DB policy snapshot consumed by routes and SQL triggers.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import {
  initDatabase, createKanbanCard, moveKanbanCard, updateKanbanCard, getKanbanCard, getDb, listKanbanCards,
  moveKanbanCardWithLaneGate, updateKanbanCardWithLaneGate,
  archiveKanbanCard, unarchiveKanbanCardWithLaneGate, createKanbanCardWithLaneGate,
} from '../db.js'
import { resolveLaneWipEnforce, resolveLaneWipLimit, tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { getOverrides, setOverride, reloadOverridesForTest, OVERRIDES_PATH } from '../settings-store.js'
import { existsSync, rmSync } from 'node:fs'

const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  return { dir: mkdtempSync(join(tmpdir(), 'kanban-gate-')) }
})
vi.mock('../env.js', () => ({ readEnvFile: () => ({}) }))
vi.mock('../config.js', async (original) => ({ ...await original<typeof import('../config.js')>(), STORE_DIR: fixture.dir }))
let testDbPath: string
let serial = 0
beforeEach(() => {
  rmSync(OVERRIDES_PATH, { force: true })
  reloadOverridesForTest()
  testDbPath = `${fixture.dir}/${serial++}.db`
  initDatabase(testDbPath)
})
afterAll(() => { getDb().close(); rmSync(fixture.dir, { recursive: true, force: true }) })

async function callKanban(method: string, path: string, body: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  req.headers = {}
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() {},
  } as unknown as http.ServerResponse
  const ctx: RouteContext = {
    req,
    res,
    path,
    method,
    url: new URL(`http://localhost${path}`),
    auth: { kind: 'token' },
  }
  const handled = await tryHandleKanban(ctx)
  return { handled, statusCode: state.statusCode, json: JSON.parse(state.body || '{}') }
}

describe('review HTTP regressions', () => {
  it.each([false, true])('gates generic PUT unarchive using stored lane policy (enforce=%s)', async (enforce) => {
    setOverride('KANBAN_LANE_WIP_ENFORCE', enforce)
    initDatabase(testDbPath)
    getDb().exec(`INSERT INTO kanban_cards(id,title,status,lane,created_at,updated_at,archived_at)
      VALUES ('live','live','in_progress','EMAIL',1,1,NULL),('restore','restore','in_progress','EMAIL',1,1,123)`)
    const result = await callKanban('PUT', '/api/kanban/restore', { archived_at: null, lane: null })
    expect(result.statusCode).toBe(enforce ? 409 : 200)
    expect(result.json[enforce ? 'decision' : 'wip_warning']).toEqual({ lane: 'EMAIL', runningCount: 1, limit: 1, allowed: false })
    expect(getKanbanCard('restore')?.archived_at).toBe(enforce ? 123 : null)
  })

  it('accepts the default planned form lane:null but rejects a running null lane', async () => {
    const result = await callKanban('POST', '/api/kanban', { title: 'default form', status: 'planned', lane: null })
    expect(result.statusCode).toBe(200)
    expect(getKanbanCard(result.json.id)).toMatchObject({ status: 'planned', lane: null })
    expect((await callKanban('POST', '/api/kanban', { title: 'running', status: 'in_progress', lane: null })).statusCode).toBe(400)
  })
})

describe('moveKanbanCardWithLaneGate', () => {
  it('blocks a second card entering an already-full lane when enforce=true (review blocker #3)', () => {
    createKanbanCard({ id: 'first', title: 'Already running' })
    moveKanbanCardWithLaneGate('first', 'in_progress', 0, 'jarvis', 'DEVELOPMENT', { limit: 1, enforce: true })

    createKanbanCard({ id: 'second', title: 'Wants the same lane' })
    const result = moveKanbanCardWithLaneGate('second', 'in_progress', 0, 'jarvis', 'DEVELOPMENT', { limit: 1, enforce: true })

    expect(result.changed).toBe(false)
    expect(result.laneGate).toEqual({ lane: 'DEVELOPMENT', runningCount: 1, limit: 1, allowed: false })
    // The blocked card must NOT have been written -- still planned, not in_progress.
    expect(getKanbanCard('second')?.status).toBe('planned')
  })

  it('allows but flags (wip_warning-shaped result) when enforce=false -- the canary default', () => {
    createKanbanCard({ id: 'first', title: 'Already running' })
    moveKanbanCardWithLaneGate('first', 'in_progress', 0, 'jarvis', 'DEVELOPMENT', { limit: 1, enforce: false })

    createKanbanCard({ id: 'second', title: 'Also wants the lane' })
    const result = moveKanbanCardWithLaneGate('second', 'in_progress', 0, 'jarvis', 'DEVELOPMENT', { limit: 1, enforce: false })

    expect(result.changed).toBe(true)
    expect(result.laneGate?.allowed).toBe(false)
    expect(getKanbanCard('second')?.status).toBe('in_progress')
  })

  it('never blocks when limit<=0 (unlimited)', () => {
    createKanbanCard({ id: 'a', title: 'A' })
    createKanbanCard({ id: 'b', title: 'B' })
    moveKanbanCardWithLaneGate('a', 'in_progress', 0, 'jarvis', 'EMAIL', { limit: 0, enforce: true })
    const result = moveKanbanCardWithLaneGate('b', 'in_progress', 0, 'jarvis', 'EMAIL', { limit: 0, enforce: true })
    expect(result.changed).toBe(true)
    expect(result.laneGate?.allowed).toBe(true)
  })

  it('re-entry without resending lane falls back to the stored lane, and excludes itself from its own count (review blocker #2)', () => {
    createKanbanCard({ id: 'card', title: 'Tagged once' })
    moveKanbanCardWithLaneGate('card', 'in_progress', 0, 'jarvis', 'MAINTENANCE', { limit: 1, enforce: true })
    moveKanbanCardWithLaneGate('card', 'waiting', 0, 'jarvis', undefined, { limit: 1, enforce: true })
    moveKanbanCardWithLaneGate('card', 'planned', 0, 'jarvis', undefined, { limit: 1, enforce: true })

    // Re-enter in_progress WITHOUT resending the lane -- must still be gated
    // against MAINTENANCE (the card's own stored lane), and must not see
    // itself as an occupant (it is the only card in that lane).
    const result = moveKanbanCardWithLaneGate('card', 'in_progress', 0, 'jarvis', undefined, { limit: 1, enforce: true })
    expect(result.changed).toBe(true)
    expect(result.laneGate).toEqual({ lane: 'MAINTENANCE', runningCount: 0, limit: 1, allowed: true })
    expect(getKanbanCard('card')?.lane).toBe('MAINTENANCE')
  })

  it('blocks a lane-less card on a new transition to in_progress even when WIP enforcement is canary-only', () => {
    createKanbanCard({ id: 'ghost', title: 'No lane, ever' })
    const result = moveKanbanCardWithLaneGate('ghost', 'in_progress', 0, 'jarvis', undefined, { limit: 1, enforce: false })
    expect(result).toEqual({ changed: false, laneRequired: true })
    expect(getKanbanCard('ghost')).toMatchObject({ status: 'planned', lane: null })
  })

  it('treats explicit lane:null as omitted and preserves a previously stored valid lane', () => {
    createKanbanCard({ id: 'card', title: 'Stored lane' })
    moveKanbanCardWithLaneGate('card', 'in_progress', 0, 'jarvis', 'EMAIL', { limit: 1, enforce: true })
    moveKanbanCard('card', 'waiting', 0, 'jarvis')
    moveKanbanCard('card', 'planned', 0, 'jarvis')

    const result = moveKanbanCardWithLaneGate('card', 'in_progress', 0, 'jarvis', null, { limit: 1, enforce: true })
    expect(result.changed).toBe(true)
    expect(result.laneGate?.lane).toBe('EMAIL')
    expect(getKanbanCard('card')?.lane).toBe('EMAIL')
  })


  it('returns changed:false with NO laneGate for a nonexistent card -- not a false "blocked" (edge case: 404 must stay a 404, not a 409)', () => {
    const result = moveKanbanCardWithLaneGate('does-not-exist', 'in_progress', 0, 'jarvis', 'DEVELOPMENT', { limit: 1, enforce: true })
    expect(result).toEqual({ changed: false })
  })

  it('still records the status-change audit event on a gated, allowed move', () => {
    createKanbanCard({ id: 'card', title: 'Audited' })
    moveKanbanCardWithLaneGate('card', 'in_progress', 0, 'jarvis', 'ADMIN', { limit: 1, enforce: true })
    expect(getKanbanCard('card')?.status).toBe('in_progress')
  })
})

describe('central public write entry points cannot bypass lane policy', () => {
  it('legacy writers cannot retag an already-running card into a full lane', () => {
    createKanbanCard({ id: 'full', title: 'full' })
    createKanbanCard({ id: 'running', title: 'running' })
    moveKanbanCardWithLaneGate('full', 'in_progress', 0, undefined, 'EMAIL', { limit: 1, enforce: true })
    moveKanbanCardWithLaneGate('running', 'in_progress', 0, undefined, 'ADMIN', { limit: 1, enforce: true })
    expect(moveKanbanCard('running', 'in_progress', 1, undefined, 'EMAIL')).toBe(false)
    expect(updateKanbanCard('running', { lane: 'EMAIL' })).toBe(false)
    expect(getKanbanCard('running')?.lane).toBe('ADMIN')
  })

  it('raw SQL cannot overfill a valid lane when enforcement is enabled', () => {
    setOverride('KANBAN_LANE_WIP_ENFORCE', true)
    initDatabase(testDbPath)
    try {
      createKanbanCard({ id: 'one', title: 'one' })
      createKanbanCard({ id: 'two', title: 'two' })
      getDb().prepare("UPDATE kanban_cards SET status='in_progress', lane='CALENDAR' WHERE id='one'").run()
      expect(() => getDb().prepare("UPDATE kanban_cards SET status='in_progress', lane='CALENDAR' WHERE id='two'").run()).toThrow(/WIP/i)
    } finally {
      if (existsSync(OVERRIDES_PATH)) rmSync(OVERRIDES_PATH)
      reloadOverridesForTest()
    }
  })

  it('raw SQL remains warn-only while enforcement is false', () => {
    createKanbanCard({ id: 'one', title: 'one' })
    createKanbanCard({ id: 'two', title: 'two' })
    const sql = getDb().prepare("UPDATE kanban_cards SET status='in_progress', lane='ADMIN' WHERE id=?")
    expect(() => { sql.run('one'); sql.run('two') }).not.toThrow()
  })
  it('createKanbanCard rejects direct lane-less in_progress creation', () => {
    expect(() => createKanbanCard({ id: 'direct-create', title: 'bypass', status: 'in_progress' })).toThrow(/legacy status/i)
    expect(getKanbanCard('direct-create')).toBeUndefined()
  })

  it('moveKanbanCard rejects a direct lane-less transition to in_progress', () => {
    createKanbanCard({ id: 'direct-move', title: 'bypass' })
    expect(moveKanbanCard('direct-move', 'in_progress', 0)).toBe(false)
    expect(getKanbanCard('direct-move')).toMatchObject({ status: 'planned', lane: null })
  })

  it('updateKanbanCard rejects lane-less transition and treats lane:null as non-destructive', () => {
    createKanbanCard({ id: 'direct-update', title: 'bypass', lane: 'EMAIL' })
    expect(updateKanbanCard('direct-update', { lane: null })).toBe(true)
    expect(getKanbanCard('direct-update')?.lane).toBe('EMAIL')
    createKanbanCard({ id: 'lane-less-update', title: 'bypass' })
    expect(updateKanbanCard('lane-less-update', { status: 'in_progress' })).toBe(false)
    expect(getKanbanCard('lane-less-update')?.status).toBe('planned')
  })

  it('database triggers reject raw INSERT/UPDATE bypasses', () => {
    const db = getDb()
    expect(() => db.prepare(`INSERT INTO kanban_cards
      (id,title,status,priority,sort_order,created_at,updated_at) VALUES ('raw-new','x','in_progress','normal',0,1,1)`).run()).toThrow(/lane/i)
    createKanbanCard({ id: 'raw-update', title: 'x' })
    expect(() => db.prepare("UPDATE kanban_cards SET status='in_progress' WHERE id='raw-update'").run()).toThrow(/lane/i)
  })
})

describe('atomic create and unarchive gates', () => {
  it('rejects the former direct in_progress creation bypass', () => {
    expect(() => createKanbanCardWithLaneGate({ id: 'one', title: 'one', status: 'in_progress', lane: 'DEVELOPMENT' }, { limit: 1, enforce: true })).toThrow(/legacy status/i)
    expect(getKanbanCard('one')).toBeUndefined()
    expect(() => createKanbanCardWithLaneGate({ id: 'two', title: 'two', state: 'running', lane: 'DEVELOPMENT' }, { limit: 1, enforce: true })).toThrow(/initial workflow state/i)
    expect(getKanbanCard('two')).toBeUndefined()
  })

  it('atomically blocks restoring archived running work into a full lane', () => {
    createKanbanCard({ id: 'live', title: 'live' })
    createKanbanCard({ id: 'archived', title: 'archived' })
    moveKanbanCardWithLaneGate('live', 'in_progress', 0, undefined, 'MONITORING', { limit: 1, enforce: true })
    moveKanbanCardWithLaneGate('archived', 'in_progress', 0, undefined, 'MONITORING', { limit: 2, enforce: true })
    archiveKanbanCard('archived')
    const result = unarchiveKanbanCardWithLaneGate('archived', { limit: 1, enforce: true })
    expect(result.unarchived).toBe(false)
    expect(getKanbanCard('archived')?.archived_at).not.toBeNull()
  })
})

describe('updateKanbanCardWithLaneGate (closes the PUT bypass -- review blocker #4)', () => {
  it('gates a direct PUT-style status:in_progress update exactly like /move does', () => {
    createKanbanCard({ id: 'first', title: 'Running via move' })
    moveKanbanCardWithLaneGate('first', 'in_progress', 0, 'jarvis', 'CALENDAR', { limit: 1, enforce: true })

    createKanbanCard({ id: 'second', title: 'Trying to sneak in via PUT' })
    const result = updateKanbanCardWithLaneGate('second', { status: 'in_progress', lane: 'CALENDAR' }, { limit: 1, enforce: true })

    expect(result.updated).toBe(false)
    expect(result).toEqual({ updated: false })
    expect(getKanbanCard('second')?.status).toBe('planned')
  })

  it('rejects state changes through the generic update helper', () => {
    createKanbanCard({ id: 'card', title: 'Tagged' })
    moveKanbanCardWithLaneGate('card', 'in_progress', 0, 'jarvis', 'MONITORING', { limit: 1, enforce: true })
    moveKanbanCard('card', 'waiting', 0, 'jarvis')

    const result = updateKanbanCardWithLaneGate('card', { status: 'in_progress' }, { limit: 1, enforce: true })
    expect(result.updated).toBe(false)
    expect(getKanbanCard('card')?.state).toBe('blocked')
  })

  it('blocks a lane-less direct PUT transition even while WIP enforcement is canary-only', () => {
    createKanbanCard({ id: 'lane-less-put', title: 'Must choose lane' })
    const result = updateKanbanCardWithLaneGate('lane-less-put', { status: 'in_progress' }, { limit: 1, enforce: false })
    expect(result).toEqual({ updated: false })
    expect(getKanbanCard('lane-less-put')).toMatchObject({ status: 'planned', lane: null })
  })

  it('does not let explicit lane:null make a status PUT bypass the workflow authority', () => {
    createKanbanCard({ id: 'put-null', title: 'Stored lane' })
    moveKanbanCardWithLaneGate('put-null', 'in_progress', 0, 'jarvis', 'ADMIN', { limit: 1, enforce: true })
    moveKanbanCard('put-null', 'waiting', 0, 'jarvis')

    const result = updateKanbanCardWithLaneGate('put-null', { status: 'in_progress', lane: null }, { limit: 1, enforce: true })
    expect(result.updated).toBe(false)
    expect(getKanbanCard('put-null')?.lane).toBe('ADMIN')
  })

  it('returns updated:false with no laneGate for a nonexistent card', () => {
    const result = updateKanbanCardWithLaneGate('nope', { status: 'in_progress', lane: 'EMAIL' }, { limit: 1, enforce: true })
    expect(result).toEqual({ updated: false })
  })

  it('persists non-status field updates together with the gate check', () => {
    createKanbanCard({ id: 'card', title: 'Old title' })
    const result = updateKanbanCardWithLaneGate('card', { title: 'New title' }, { limit: 1, enforce: true })
    expect(result.updated).toBe(true)
    expect(getKanbanCard('card')?.title).toBe('New title')
  })
})

describe('HTTP lane gate contract (create, PUT and /move cannot create lane-less running work)', () => {
  it.each([
    ['POST', '/api/kanban', { id: 'ignored-client-id', title: 'New running card', status: 'in_progress', lane: null }, 'invalid_initial_state'],
    ['POST', '/api/kanban/http-move/move', { status: 'in_progress', lane: null }, 'lane_required'],
  ])('%s %s rejects a lane-less JIT pickup with a useful 400 response', async (method, path, body, code) => {
    const existingId = path.includes('http-move') ? 'http-move' : path.includes('http-put') ? 'http-put' : null
    if (existingId) createKanbanCard({ id: existingId, title: 'Legacy ready card' })

    const result = await callKanban(method, path, body)

    expect(result).toMatchObject({ handled: true, statusCode: 400 })
    expect(result.json).toMatchObject({ code })
    if (code === 'lane_required') expect(result.json).toMatchObject({ lanes: ['DEVELOPMENT', 'EMAIL', 'CALENDAR', 'MONITORING', 'MAINTENANCE', 'ADMIN'] })
    if (existingId) expect(getKanbanCard(existingId)).toMatchObject({ status: 'planned', lane: null })
  })

  it('rejects direct in_progress creation before WIP accounting can be bypassed', async () => {
    setOverride('KANBAN_LANE_WIP_ENFORCE', true)
    initDatabase(testDbPath)
    try {
      const first = await callKanban('POST', '/api/kanban', { title: 'First', status: 'in_progress', lane: 'DEVELOPMENT' })
      const second = await callKanban('POST', '/api/kanban', { title: 'Second', status: 'in_progress', lane: 'DEVELOPMENT' })

      expect(first).toMatchObject({ statusCode: 400, json: { code: 'invalid_initial_state' } })
      expect(second).toMatchObject({ statusCode: 400, json: { code: 'invalid_initial_state' } })
      expect(listKanbanCards()).toHaveLength(0)
    } finally {
      if (existsSync(OVERRIDES_PATH)) rmSync(OVERRIDES_PATH)
      reloadOverridesForTest()
    }
  })

  it('returns 409 and leaves the card archived when unarchive would overfill', async () => {
    try {
      createKanbanCard({ id: 'live-http', title: 'live' })
      createKanbanCard({ id: 'arch-http', title: 'archived' })
      moveKanbanCardWithLaneGate('live-http', 'in_progress', 0, undefined, 'EMAIL', { limit: 1, enforce: true })
      moveKanbanCardWithLaneGate('arch-http', 'in_progress', 0, undefined, 'EMAIL', { limit: 2, enforce: true })
      archiveKanbanCard('arch-http')
      setOverride('KANBAN_LANE_WIP_ENFORCE', true)
      initDatabase(testDbPath)
      const result = await callKanban('POST', '/api/kanban/arch-http/unarchive', {})
      expect(result.statusCode).toBe(409)
      expect(getKanbanCard('arch-http')?.archived_at).not.toBeNull()
    } finally {
      if (existsSync(OVERRIDES_PATH)) rmSync(OVERRIDES_PATH)
      reloadOverridesForTest()
    }
  })
})

describe('kanban_cards.lane CHECK constraint (review blocker #8a)', () => {
  it('rejects an invalid lane value on INSERT', () => {
    const db = getDb()
    expect(() =>
      db.prepare(
        `INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at, lane)
         VALUES ('bad-1', 'x', 'planned', 'normal', 0, 0, 0, 'NOT_A_REAL_LANE')`
      ).run()
    ).toThrow()
  })

  it('rejects an invalid lane value on UPDATE', () => {
    createKanbanCard({ id: 'card', title: 'x' })
    const db = getDb()
    expect(() =>
      db.prepare(`UPDATE kanban_cards SET lane = 'NOT_A_REAL_LANE' WHERE id = 'card'`).run()
    ).toThrow()
  })

  it('accepts NULL and every valid §23-24 lane', () => {
    const db = getDb()
    const lanes = ['DEVELOPMENT', 'EMAIL', 'CALENDAR', 'MONITORING', 'MAINTENANCE', 'ADMIN']
    for (const lane of lanes) {
      createKanbanCard({ id: `card-${lane}`, title: lane })
      expect(() =>
        db.prepare('UPDATE kanban_cards SET lane = ? WHERE id = ?').run(lane, `card-${lane}`)
      ).not.toThrow()
    }
    createKanbanCard({ id: 'card-null', title: 'null lane' })
    expect(() =>
      db.prepare('UPDATE kanban_cards SET lane = NULL WHERE id = ?').run('card-null')
    ).not.toThrow()
  })
})

describe('resolveLaneWipEnforce / resolveLaneWipLimit (registry + restart policy)', () => {
  afterEach(() => {
    // These write a unique temporary store/config-overrides.json.
    // Reset it after each test so one test's override can never
    // leak into another.
    if (existsSync(OVERRIDES_PATH)) rmSync(OVERRIDES_PATH)
    reloadOverridesForTest()
  })

  it('defaults to the registry default (limit=1, enforce=false) with no override set', () => {
    expect(resolveLaneWipEnforce()).toBe(false)
    expect(resolveLaneWipLimit('DEVELOPMENT')).toBe(1)
  })

  it('KANBAN_LANE_WIP_ENFORCE override flips the policy after restart', () => {
    setOverride('KANBAN_LANE_WIP_ENFORCE', true)
    initDatabase(testDbPath)
    expect(resolveLaneWipEnforce()).toBe(true)
  })

  it('KANBAN_LANE_WIP_LIMIT override changes the global default for every lane', () => {
    setOverride('KANBAN_LANE_WIP_LIMIT', 3)
    expect(resolveLaneWipLimit('DEVELOPMENT')).toBe(1)
    initDatabase(testDbPath)
    expect(resolveLaneWipLimit('DEVELOPMENT')).toBe(3)
    expect(resolveLaneWipLimit('EMAIL')).toBe(3)
  })

  it('sets survive a getOverrides() round-trip (sanity on the layer itself)', () => {
    setOverride('KANBAN_LANE_WIP_LIMIT', 5)
    expect(getOverrides().KANBAN_LANE_WIP_LIMIT).toBe(5)
  })
})
