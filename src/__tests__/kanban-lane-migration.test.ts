// DB-level contract tests for the §23-24 lane column and per-lane running
// count (governance v1.0, TASK-0018). Same harness as kanban-move-audit.test.ts:
// production entry points against an in-memory DB seeded with the production
// schema.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, createKanbanCard, updateKanbanCard, moveKanbanCard, moveKanbanCardWithLaneGate, getKanbanCard, countInProgressInLane, getDb, insertImportedKanbanCard } from '../db.js'

const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  return { dir: mkdtempSync(join(tmpdir(), 'kanban-migration-store-')) }
})
vi.mock('../env.js', () => ({ readEnvFile: () => ({}) }))
vi.mock('../config.js', async (original) => ({ ...await original<typeof import('../config.js')>(), STORE_DIR: fixture.dir }))
afterAll(() => { getDb().close(); rmSync(fixture.dir, { recursive: true, force: true }) })

beforeEach(() => {
  initDatabase(':memory:')
})

describe('kanban lane column', () => {
  it('new cards start with lane=null (pre-governance backlog is unaffected)', () => {
    createKanbanCard({ id: 'card-a', title: 'Untagged card' })
    expect(getKanbanCard('card-a')?.lane).toBeNull()
  })

  it('new cards can be prepared with an explicit valid lane before JIT pickup', () => {
    createKanbanCard({ id: 'card-prepared', title: 'Prepared card', lane: 'DEVELOPMENT' })
    expect(getKanbanCard('card-prepared')?.lane).toBe('DEVELOPMENT')
  })

  it('the legacy helper refuses a lane-less transition into in_progress', () => {
    createKanbanCard({ id: 'card-b', title: 'No lane passed' })
    expect(moveKanbanCard('card-b', 'in_progress', 0, 'jarvis')).toBe(false)
    expect(getKanbanCard('card-b')?.status).toBe('planned')
    expect(getKanbanCard('card-b')?.lane).toBeNull()
  })

  it('moveKanbanCard persists an explicit lane on entering in_progress', () => {
    createKanbanCard({ id: 'card-c', title: 'Lane-tagged card' })
    moveKanbanCardWithLaneGate('card-c', 'in_progress', 0, 'jarvis', 'DEVELOPMENT', { limit: 1, enforce: true })
    expect(getKanbanCard('card-c')?.lane).toBe('DEVELOPMENT')
  })

  it('a lane set once survives a later move that omits the lane argument', () => {
    createKanbanCard({ id: 'card-d', title: 'Lane persists across moves' })
    moveKanbanCardWithLaneGate('card-d', 'in_progress', 0, 'jarvis', 'EMAIL', { limit: 1, enforce: true })
    moveKanbanCard('card-d', 'done', 0, 'jarvis')
    expect(getKanbanCard('card-d')?.lane).toBe('EMAIL')
  })
})

describe('countInProgressInLane', () => {
  it('is zero for an empty lane', () => {
    expect(countInProgressInLane('DEVELOPMENT')).toBe(0)
  })

  it('counts only lane-tagged in_progress cards, excluding archived and other lanes', () => {
    createKanbanCard({ id: 'dev-1', title: 'Dev running' })
    moveKanbanCardWithLaneGate('dev-1', 'in_progress', 0, 'jarvis', 'DEVELOPMENT', { limit: 1, enforce: true })

    createKanbanCard({ id: 'email-1', title: 'Email running (different lane)' })
    moveKanbanCardWithLaneGate('email-1', 'in_progress', 0, 'jarvis', 'EMAIL', { limit: 1, enforce: true })

    createKanbanCard({ id: 'dev-2', title: 'Dev planned, not running' })

    expect(countInProgressInLane('DEVELOPMENT')).toBe(1)
    expect(countInProgressInLane('EMAIL')).toBe(1)
    expect(countInProgressInLane('MONITORING')).toBe(0)
  })

  it('never counts legacy lane=null ghost cards, however many are in_progress', () => {
    const db = getDb()
    db.exec('DROP TRIGGER kanban_lane_required_update')
    for (let i = 0; i < 5; i++) {
      createKanbanCard({ id: `ghost-${i}`, title: `Ghost WIP ${i}` })
      db.prepare("UPDATE kanban_cards SET status='in_progress' WHERE id=?").run(`ghost-${i}`)
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM kanban_cards WHERE status='in_progress' AND lane IS NULL").get()).toEqual({ n: 5 })
    expect(countInProgressInLane('DEVELOPMENT')).toBe(0)
    expect(countInProgressInLane('ADMIN')).toBe(0)
  })

  it('excludeId lets a card moving within its own lane not compete with itself', () => {
    createKanbanCard({ id: 'self-1', title: 'Already running' })
    moveKanbanCardWithLaneGate('self-1', 'in_progress', 0, 'jarvis', 'MAINTENANCE', { limit: 1, enforce: true })
    // Same card re-evaluated (e.g. a sort_order-only re-move) should not see
    // itself as an occupant of the lane it is already in.
    expect(countInProgressInLane('MAINTENANCE', 'self-1')).toBe(0)
    // A different card asking the same question DOES see it.
    expect(countInProgressInLane('MAINTENANCE', 'someone-else')).toBe(1)
  })
})

describe('on-disk legacy lane migration', () => {
  it('configures a bounded wait for competing database connections', () => {
    expect(getDb().pragma('busy_timeout', { simple: true })).toBe(5000)
  })

  it('fleet restore preserves valid lanes and legacy lane-less running cards', () => {
    const base = { title: 'restored', status: 'in_progress', priority: 'normal', sort_order: 0, created_at: 1, updated_at: 1 }
    insertImportedKanbanCard({ ...base, id: 'new-backup', lane: 'DEVELOPMENT' })
    insertImportedKanbanCard({ ...base, id: 'old-backup' })
    expect(getKanbanCard('new-backup')).toMatchObject({ status: 'in_progress', lane: 'DEVELOPMENT' })
    expect(getKanbanCard('old-backup')).toMatchObject({ status: 'in_progress', lane: null })
  })

  it('keeps migrated lane-less running cards editable and reorderable without permitting a new transition', () => {
    const db = getDb()
    const triggerSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='kanban_lane_required_update'").get() as { sql: string }).sql
    db.exec('DROP TRIGGER kanban_lane_required_update')
    createKanbanCard({ id: 'legacy', title: 'legacy' })
    db.prepare("UPDATE kanban_cards SET status='in_progress', workflow_state='running' WHERE id='legacy'").run()
    db.exec(triggerSql)
    expect(updateKanbanCard('legacy', { title: 'edited' })).toBe(true)
    expect(moveKanbanCard('legacy', 'in_progress', 7)).toBe(true)
    expect(getKanbanCard('legacy')).toMatchObject({ title: 'edited', sort_order: 7, lane: null })
  })
  it('preserves deleted/noncontiguous rowids used as human-facing #seq references', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanban-lane-migrate-'))
    const path = join(dir, 'legacy.db')
    const legacy = new Database(path)
    legacy.exec(`CREATE TABLE kanban_cards (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
      status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','waiting','done')),
      assignee TEXT, priority TEXT NOT NULL DEFAULT 'normal', project TEXT, due_date INTEGER,
      sort_order REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      archived_at INTEGER, parent_id TEXT, dispatched_at INTEGER
    )`)
    const insert = legacy.prepare(`INSERT INTO kanban_cards
      (rowid,id,title,status,priority,sort_order,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`)
    insert.run(1, 'first', 'first', 'planned', 'normal', 0, 1, 1)
    insert.run(3, 'third', 'third', 'in_progress', 'normal', 1, 1, 1)
    insert.run(9, 'ninth', 'ninth', 'done', 'normal', 2, 1, 1)
    legacy.close()

    try {
      initDatabase(path)
      expect(getKanbanCard('first')?.seq).toBe(1)
      expect(getKanbanCard('third')).toMatchObject({ seq: 3, status: 'in_progress', lane: null })
      expect(getKanbanCard('ninth')?.seq).toBe(9)
      const indexes = getDb().prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='kanban_cards'").all() as Array<{ name: string }>
      expect(indexes.map((row) => row.name)).toContain('idx_kanban_lane_status_archive')
    } finally {
      initDatabase(':memory:')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed and rolls the whole rebuild back when a legacy row violates the new lane CHECK', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanban-lane-failclosed-'))
    const path = join(dir, 'legacy.db')
    const legacy = new Database(path)
    legacy.exec(`CREATE TABLE kanban_cards (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
      status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','testing','waiting','done')),
      assignee TEXT, priority TEXT NOT NULL DEFAULT 'normal', project TEXT, due_date INTEGER,
      sort_order REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      archived_at INTEGER, parent_id TEXT, dispatched_at INTEGER, lane TEXT
    ); INSERT INTO kanban_cards (rowid,id,title,status,priority,created_at,updated_at,lane)
       VALUES (7,'bad','bad','planned','normal',1,1,'INVALID')`)
    legacy.close()

    try {
      expect(() => initDatabase(path)).toThrow()
      const check = new Database(path)
      expect(check.prepare("SELECT rowid, lane FROM kanban_cards WHERE id='bad'").get()).toEqual({ rowid: 7, lane: 'INVALID' })
      expect(check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kanban_cards_lane_new'").get()).toBeUndefined()
      check.close()
    } finally {
      initDatabase(':memory:')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
