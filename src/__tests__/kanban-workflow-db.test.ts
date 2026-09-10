import Database from 'better-sqlite3'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createKanbanCard,
  getDb,
  getKanbanCard,
  getKanbanCardEvents,
  insertImportedKanbanCard,
  initDatabase,
  transitionKanbanWorkflowState,
} from '../db.js'

const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  return { dir: mkdtempSync(join(tmpdir(), 'kanban-workflow-store-')) }
})
vi.mock('../env.js', () => ({ readEnvFile: () => ({}) }))
vi.mock('../config.js', async (original) => ({ ...await original<typeof import('../config.js')>(), STORE_DIR: fixture.dir }))
afterAll(() => { getDb().close(); rmSync(fixture.dir, { recursive: true, force: true }) })

beforeEach(() => initDatabase(':memory:'))

describe('workflow schema migration', () => {
  it('keeps the legacy backlog canonical-NULL on disk while deriving safe read state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kanban-workflow-migrate-'))
    const path = join(dir, 'legacy.db')
    const legacy = new Database(path)
    legacy.exec(`CREATE TABLE kanban_cards (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
      status TEXT NOT NULL CHECK(status IN ('planned','in_progress','testing','waiting','done')),
      assignee TEXT, priority TEXT NOT NULL DEFAULT 'normal', project TEXT, due_date INTEGER,
      sort_order REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      archived_at INTEGER, parent_id TEXT, dispatched_at INTEGER, lane TEXT
    )`)
    const insert = legacy.prepare('INSERT INTO kanban_cards (rowid,id,title,status,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    ;(['planned', 'in_progress', 'testing', 'waiting', 'done'] as const).forEach((status, i) => insert.run(i * 3 + 1, status, status, status, 'normal', 1, 1))
    legacy.close()
    try {
      initDatabase(path)
      expect(getDb().prepare('SELECT rowid,id,status,workflow_state,repair_attempts FROM kanban_cards ORDER BY rowid').all()).toEqual([
        { rowid: 1, id: 'planned', status: 'planned', workflow_state: null, repair_attempts: 0 },
        { rowid: 4, id: 'in_progress', status: 'in_progress', workflow_state: null, repair_attempts: 0 },
        { rowid: 7, id: 'testing', status: 'testing', workflow_state: null, repair_attempts: 0 },
        { rowid: 10, id: 'waiting', status: 'waiting', workflow_state: null, repair_attempts: 0 },
        { rowid: 13, id: 'done', status: 'done', workflow_state: null, repair_attempts: 0 },
      ])
      expect(getKanbanCard('testing')).toMatchObject({ status: 'testing', workflow_state: 'verify', state: 'verify' })
    } finally {
      initDatabase(':memory:')
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('transactional workflow transitions', () => {
  it.each(['running', 'verify', 'repair', 'blocked', 'done'] as const)('rejects canonical %s creation outside the workflow graph', (state) => {
    expect(() => createKanbanCard({ id: `card-${state}`, title: state, state })).toThrow(/initial workflow state/i)
    expect(getKanbanCard(`card-${state}`)).toBeUndefined()
  })

  it.each(['in_progress', 'testing', 'waiting', 'done'] as const)('rejects unsafe legacy %s creation while retaining planned compatibility', (status) => {
    expect(() => createKanbanCard({ id: `card-${status}`, title: status, status })).toThrow(/legacy status/i)
    expect(getKanbanCard(`card-${status}`)).toBeUndefined()
    createKanbanCard({ id: `planned-${status}`, title: 'planned', status: 'planned' })
    expect(getKanbanCard(`planned-${status}`)).toMatchObject({ state: 'ready', status: 'planned' })
  })

  it('rejects conflicting canonical and legacy creation fields', () => {
    expect(() => createKanbanCard({ id: 'conflict', title: 'conflict', state: 'new', status: 'done' })).toThrow(/conflicting workflow/i)
    expect(getKanbanCard('conflict')).toBeUndefined()
  })

  it('preserves compatible canonical fleet fields, keeps old snapshots JIT, and rejects contradictions', () => {
    insertImportedKanbanCard({ id: 'new-snapshot', title: 'new', status: 'testing', workflow_state: 'repair', repair_attempts: 2, priority: 'normal', sort_order: 0, created_at: 1, updated_at: 1 })
    insertImportedKanbanCard({ id: 'old-snapshot', title: 'old', status: 'waiting', priority: 'normal', sort_order: 0, created_at: 1, updated_at: 1 })
    expect(getKanbanCard('new-snapshot')).toMatchObject({ state: 'repair', status: 'testing', repair_attempts: 2 })
    expect(getDb().prepare("SELECT workflow_state FROM kanban_cards WHERE id='old-snapshot'").get()).toEqual({ workflow_state: null })
    expect(getKanbanCard('old-snapshot')).toMatchObject({ workflow_state: 'blocked', state: 'blocked', status: 'waiting', repair_attempts: 0 })
    expect(() => insertImportedKanbanCard({ id: 'contradiction', title: 'bad', status: 'done', workflow_state: 'repair', priority: 'normal', sort_order: 0, created_at: 1, updated_at: 1 })).toThrow(/conflicting workflow/i)
    expect(getKanbanCard('contradiction')).toBeUndefined()
  })

  it('writes canonical state, legacy projection, and one enriched audit row atomically', () => {
    createKanbanCard({ id: 'card', title: 'Card', state: 'new' })
    expect(transitionKanbanWorkflowState('card', 'ready', 10, 'alex')).toMatchObject({ changed: true, state: 'ready' })
    expect(getKanbanCard('card')).toMatchObject({ workflow_state: 'ready', state: 'ready', status: 'planned', repair_attempts: 0 })
    expect(getKanbanCardEvents('card')).toEqual([
      expect.objectContaining({ from_state: 'new', to_state: 'ready', from_status: 'planned', to_status: 'planned', actor: 'alex' }),
    ])
  })

  it('rolls back an invalid transition without an event', () => {
    createKanbanCard({ id: 'card', title: 'Card', state: 'ready' })
    expect(transitionKanbanWorkflowState('card', 'done', 0, 'alex')).toMatchObject({ changed: false, reason: 'invalid_transition' })
    expect(getKanbanCard('card')).toMatchObject({ state: 'ready', status: 'planned' })
    expect(getKanbanCardEvents('card')).toHaveLength(0)
  })

  it('requires a lane for ready -> running and preserves the existing WIP gate', () => {
    createKanbanCard({ id: 'card', title: 'Card', state: 'ready' })
    expect(transitionKanbanWorkflowState('card', 'running', 0, 'alex')).toMatchObject({ changed: false, laneRequired: true })
    expect(transitionKanbanWorkflowState('card', 'running', 0, 'alex', 'DEVELOPMENT', { limit: 1, enforce: true })).toMatchObject({ changed: true, state: 'running' })
    expect(getKanbanCard('card')).toMatchObject({ state: 'running', status: 'in_progress', lane: 'DEVELOPMENT' })
  })

  it('blocks the third repair request in the same audited transaction', () => {
    createKanbanCard({ id: 'card', title: 'Card', state: 'ready' })
    transitionKanbanWorkflowState('card', 'running', 0, 'dev', 'DEVELOPMENT')
    transitionKanbanWorkflowState('card', 'verify', 0, 'dev')
    transitionKanbanWorkflowState('card', 'repair', 0, 'qa')
    transitionKanbanWorkflowState('card', 'verify', 0, 'dev')
    transitionKanbanWorkflowState('card', 'repair', 0, 'qa')
    transitionKanbanWorkflowState('card', 'verify', 0, 'dev')
    expect(transitionKanbanWorkflowState('card', 'repair', 0, 'qa')).toMatchObject({ changed: true, state: 'blocked', reason: 'repair_limit_exhausted' })
    expect(getKanbanCard('card')).toMatchObject({ state: 'blocked', status: 'waiting', repair_attempts: 2 })
    expect(getKanbanCardEvents('card').at(-1)).toMatchObject({ from_state: 'verify', to_state: 'blocked', reason: 'repair_limit_exhausted' })
  })
})
