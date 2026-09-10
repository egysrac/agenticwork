import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'

const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  return { dir: mkdtempSync(join(tmpdir(), 'kanban-independent-')), env: {} as Record<string, string> }
})
vi.mock('../env.js', () => ({ readEnvFile: () => ({ ...fixture.env }) }))
vi.mock('../config.js', async (original) => ({ ...await original<typeof import('../config.js')>(), STORE_DIR: fixture.dir }))
import { initDatabase, getDb, insertImportedKanbanCard, countInProgressInLane, updateKanbanCardWithLaneGate } from '../db.js'
import { reloadOverridesForTest, OVERRIDES_PATH, setOverride } from '../settings-store.js'

import { resolveLaneWipEnforce, resolveLaneWipLimit } from '../web/routes/kanban.js'
import { getSettingDefinition } from '../config-registry.js'

let path: string
let peer: Database.Database
let serial = 0
beforeEach(() => {
  peer?.close()
  for (const key of Object.keys(fixture.env)) delete fixture.env[key]
  rmSync(OVERRIDES_PATH, { force: true })
  reloadOverridesForTest()
  path = join(fixture.dir, `${serial++}.db`)
  initDatabase(path)
  peer = new Database(path)
})
afterAll(() => { peer.close(); getDb().close(); rmSync(fixture.dir, { recursive: true, force: true }) })

function insert(connection: Database.Database, id: string, status = 'planned', lane: string | null = null) {
  connection.prepare('INSERT INTO kanban_cards (id,title,status,lane,created_at,updated_at) VALUES (?,?,?,?,1,1)').run(id, id, status, lane)
}

describe('NULL-ID legacy regressions', () => {
  function legacyNull(status = 'planned') {
    // Simulate a pre-repair database, then exercise the real restart migration.
    peer.exec('DROP TRIGGER IF EXISTS kanban_id_required_insert; DROP TRIGGER IF EXISTS kanban_id_required_update')
    peer.prepare("INSERT INTO kanban_cards(rowid,id,title,status,lane,created_at,updated_at) VALUES (71,NULL,'legacy',?,'EMAIL',1,1)").run(status)
    setOverride('KANBAN_LANE_WIP_ENFORCE', true)
    initDatabase(path)
  }
  it('preserves legacy NULL IDs and rowids but excludes the updated row by rowid', () => {
    legacyNull()
    insert(peer, 'occupant', 'in_progress', 'EMAIL')
    expect(() => peer.exec("UPDATE kanban_cards SET status='in_progress' WHERE rowid=71")).toThrow('WIP limit reached')
    expect(peer.prepare('SELECT rowid,id,status FROM kanban_cards WHERE rowid=71').get()).toEqual({ rowid: 71, id: null, status: 'planned' })
    expect(() => peer.exec("UPDATE kanban_cards SET title='edited' WHERE rowid=71")).not.toThrow()
    peer.exec("DELETE FROM kanban_cards WHERE id='occupant'")
    expect(() => peer.exec("UPDATE kanban_cards SET status='in_progress' WHERE rowid=71")).not.toThrow()
  })
  it('counts NULL-ID occupants in application gates', () => {
    legacyNull('in_progress')
    insert(peer, 'candidate', 'planned', 'EMAIL')
    expect(countInProgressInLane('EMAIL')).toBe(1)
    // Generic updates are content-only under TASK-0019; state must use /move.
    expect(updateKanbanCardWithLaneGate('candidate', { status: 'in_progress' })).toEqual({ updated: false })
  })
  it('rejects future NULL-ID insertions and ID erasure without deleting legacy rows', () => {
    legacyNull()
    expect(() => peer.exec("INSERT INTO kanban_cards(id,title,created_at,updated_at) VALUES(NULL,'bad',1,1)")).toThrow('kanban id required')
    insert(peer, 'valid')
    expect(() => peer.exec("UPDATE kanban_cards SET id=NULL WHERE id='valid'")).toThrow('kanban id required')
    expect(peer.prepare('SELECT rowid,id FROM kanban_cards WHERE rowid=71').get()).toEqual({ rowid: 71, id: null })
  })
})

describe('persistent triggers on an independent plain SQLite connection', () => {
  it('reconciles old-binary status-only writes without erasing compatible canonical detail', () => {
    peer.prepare("INSERT INTO kanban_cards (id,title,status,workflow_state,created_at,updated_at) VALUES ('repair','repair','testing','repair',1,1)").run()
    peer.exec("UPDATE kanban_cards SET title='old edit' WHERE id='repair'")
    expect(peer.prepare("SELECT status,workflow_state FROM kanban_cards WHERE id='repair'").get()).toEqual({ status: 'testing', workflow_state: 'repair' })
    peer.exec("UPDATE kanban_cards SET status='planned' WHERE id='repair'")
    expect(peer.prepare("SELECT status,workflow_state FROM kanban_cards WHERE id='repair'").get()).toEqual({ status: 'planned', workflow_state: 'ready' })
    peer.exec("UPDATE kanban_cards SET status='done' WHERE id='repair'")
    expect(peer.prepare("SELECT status,workflow_state FROM kanban_cards WHERE id='repair'").get()).toEqual({ status: 'done', workflow_state: 'done' })
  })

  it('blocks tagging a legacy running ghost into an already full lane on a plain connection', () => {
    setOverride('KANBAN_LANE_WIP_ENFORCE', true)
    initDatabase(path)
    insert(peer, 'occupant', 'in_progress', 'DEVELOPMENT')
    insertImportedKanbanCard({ id: 'ghost', title: 'old snapshot', status: 'in_progress', priority: 'normal', sort_order: 0, created_at: 1, updated_at: 1 })
    expect(() => peer.exec("UPDATE kanban_cards SET lane='DEVELOPMENT' WHERE id='ghost'")).toThrow('WIP limit reached')
    expect(peer.prepare("SELECT lane FROM kanban_cards WHERE id='ghost'").get()).toEqual({ lane: null })
    expect(() => peer.exec("UPDATE kanban_cards SET lane='ADMIN' WHERE id='ghost'")).not.toThrow()
  })

  it('publishes configured lane overrides and unlimited lanes atomically at restart', () => {
    setOverride('KANBAN_LANE_WIP_ENFORCE', true)
    setOverride('KANBAN_LANE_WIP_LIMIT', 2)
    fixture.env.KANBAN_LANE_WIP_LIMIT_DEVELOPMENT = '3'
    fixture.env.KANBAN_LANE_WIP_LIMIT_ADMIN = '0'
    fixture.env.KANBAN_LANE_WIP_LIMIT_MONITORING = 'bad'
    initDatabase(path)
    expect(resolveLaneWipLimit('DEVELOPMENT')).toBe(3)
    expect(resolveLaneWipLimit('ADMIN')).toBe(0)
    expect(resolveLaneWipLimit('MONITORING')).toBe(2)
    for (let i = 0; i < 3; i++) insert(peer, `dev-${i}`, 'in_progress', 'DEVELOPMENT')
    expect(() => insert(peer, 'dev-over', 'in_progress', 'DEVELOPMENT')).toThrow('WIP limit reached')
    for (let i = 0; i < 4; i++) insert(peer, `admin-${i}`, 'in_progress', 'ADMIN')
    fixture.env.KANBAN_LANE_WIP_LIMIT_DEVELOPMENT = '1'
    expect(resolveLaneWipLimit('DEVELOPMENT')).toBe(3)
  })

  it('preserves over-capacity valid fleet snapshots and rejects malformed rows without leaving flags', () => {
    setOverride('KANBAN_LANE_WIP_ENFORCE', true)
    initDatabase(path)
    const base = { title: 'snapshot', status: 'in_progress', priority: 'normal', sort_order: 0, created_at: 1, updated_at: 1, lane: 'DEVELOPMENT' }
    getDb().transaction(() => {
      insertImportedKanbanCard({ ...base, id: 'restore-a' })
      insertImportedKanbanCard({ ...base, id: 'restore-b' })
      expect(() => insertImportedKanbanCard({ ...base, id: 'invalid', status: 'INVALID' })).toThrow(/CHECK/)
      expect(() => insertImportedKanbanCard({ ...base, id: 'invalid-lane', lane: 'INVALID' })).toThrow('Invalid execution lane')
      expect(getDb().prepare('SELECT * FROM kanban_runtime_flags').all()).toEqual([])
    }).immediate()
    expect(peer.prepare('SELECT COUNT(*) AS n FROM kanban_cards').get()).toEqual({ n: 2 })
    expect(() => insert(peer, 'after-restore', 'in_progress', 'DEVELOPMENT')).toThrow('WIP limit reached')
  })

  it('blocks raw transitions and unarchive in enforce mode, but permits edits of an occupied lane', () => {
    setOverride('KANBAN_LANE_WIP_ENFORCE', true)
    initDatabase(path)
    insert(peer, 'live', 'in_progress', 'DEVELOPMENT')
    insert(peer, 'planned', 'planned', 'DEVELOPMENT')
    expect(() => peer.exec("UPDATE kanban_cards SET status='in_progress' WHERE id='planned'")).toThrow('WIP limit reached')
    insertImportedKanbanCard({ id: 'archived', title: 'snapshot', status: 'in_progress', priority: 'normal', sort_order: 0, created_at: 1, updated_at: 1, archived_at: 1, lane: 'DEVELOPMENT' })
    expect(() => peer.exec("UPDATE kanban_cards SET archived_at=NULL WHERE id='archived'")).toThrow('WIP limit reached')
    expect(() => peer.exec("UPDATE kanban_cards SET title='edited',sort_order=3 WHERE id='live'")).not.toThrow()
    expect(peer.prepare("SELECT archived_at FROM kanban_cards WHERE id='archived'").get()).toEqual({ archived_at: 1 })
  })

  it('allows raw overfill in canary mode but still constrains lane-less new starts', () => {
    insert(peer, 'first', 'in_progress', 'DEVELOPMENT')
    insert(peer, 'second', 'in_progress', 'DEVELOPMENT')
    insert(peer, 'third', 'planned', 'DEVELOPMENT')
    expect(() => peer.exec("UPDATE kanban_cards SET status='in_progress' WHERE id='third'")).not.toThrow()
    expect(() => insert(peer, 'no-lane', 'in_progress')).toThrow('execution lane required')
    expect(peer.prepare("SELECT COUNT(*) AS n FROM kanban_cards WHERE status='in_progress'").get()).toEqual({ n: 3 })
  })

  it.each([false, true])('never exposes the import exemption to a concurrent connection (failure=%s)', (fail) => {
    let observed = false
    peer.pragma('busy_timeout=0')
    getDb().function('test_observe_import', (flag) => {
      observed = true
      expect(flag).toBe(1)
      expect(peer.prepare('SELECT * FROM kanban_runtime_flags').all()).toEqual([])
      expect(() => insert(peer, 'competing', 'in_progress')).toThrow(/locked/)
      return 1
    })
    // TEMP trigger: this test callback is never persisted in the DB schema.
    getDb().exec(`CREATE TEMP TRIGGER observe_import BEFORE INSERT ON kanban_cards
      WHEN NEW.id='imported' BEGIN SELECT test_observe_import((SELECT value FROM kanban_runtime_flags WHERE key='legacy_import'));
      ${fail ? "SELECT RAISE(ABORT, 'injected failure');" : ''} END`)
    const restore = () => insertImportedKanbanCard({ id: 'imported', title: 'snapshot', status: 'in_progress', priority: 'normal', sort_order: 0, created_at: 1, updated_at: 1 })
    if (fail) expect(restore).toThrow('injected failure')
    else restore()
    expect(observed).toBe(true)
    expect(peer.prepare('SELECT * FROM kanban_runtime_flags').all()).toEqual([])
    expect(() => insert(peer, 'after', 'in_progress')).toThrow('execution lane required')
  })

  it('serializes simultaneous independent worker starts so only one can claim the last slot', async () => {
    setOverride('KANBAN_LANE_WIP_ENFORCE', true)
    initDatabase(path)
    const barrier = new SharedArrayBuffer(4)
    const workers = ['racer-a', 'racer-b'].map((id) => new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const Database = require(workerData.modulePath);
      const db = new Database(workerData.path);
      db.pragma('busy_timeout=5000');
      parentPort.postMessage('ready');
      Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
      let result;
      try {
        db.prepare("INSERT INTO kanban_cards(id,title,status,lane,created_at,updated_at) VALUES (?,?,'in_progress','DEVELOPMENT',1,1)").run(workerData.id, workerData.id);
        result = 'ok';
      } catch (err) { result = err.message; }
      db.close(); parentPort.postMessage(result);
    `, { eval: true, workerData: { id, path, barrier, modulePath: createRequire(import.meta.url).resolve('better-sqlite3') } }))
    try {
      const ready = workers.map((worker) => new Promise<void>((resolve, reject) => {
        worker.once('message', () => resolve()); worker.once('error', reject)
      }))
      const results = workers.map((worker) => new Promise<string>((resolve, reject) => {
        worker.on('message', (message) => { if (message !== 'ready') resolve(message) }); worker.once('error', reject)
      }))
      await Promise.all(ready)
      Atomics.store(new Int32Array(barrier), 0, 1)
      Atomics.notify(new Int32Array(barrier), 0)
      expect((await Promise.all(results)).sort()).toEqual(['execution lane WIP limit reached', 'ok'])
      expect(peer.prepare("SELECT COUNT(*) AS n FROM kanban_cards WHERE status='in_progress'").get()).toEqual({ n: 1 })
    } finally { await Promise.all(workers.map((worker) => worker.terminate())) }
  }, 15000)

  it('applies saved lane policy only at DB initialization, consistently for HTTP and raw writers', () => {
    setOverride('KANBAN_LANE_WIP_ENFORCE', true)
    setOverride('KANBAN_LANE_WIP_LIMIT', 2)
    expect(resolveLaneWipEnforce()).toBe(false)
    expect(resolveLaneWipLimit('DEVELOPMENT')).toBe(1)
    expect(getSettingDefinition('KANBAN_LANE_WIP_ENFORCE')?.requiresRestart).toBe(true)
    expect(getSettingDefinition('KANBAN_LANE_WIP_LIMIT')?.requiresRestart).toBe(true)
    initDatabase(path)
    expect(resolveLaneWipEnforce()).toBe(true)
    expect(resolveLaneWipLimit('DEVELOPMENT')).toBe(2)
    insert(peer, 'one', 'in_progress', 'DEVELOPMENT')
    insert(peer, 'two', 'in_progress', 'DEVELOPMENT')
    expect(() => insert(peer, 'three', 'in_progress', 'DEVELOPMENT')).toThrow('WIP limit reached')
  })

  it('restores old snapshots and cleans the exemption on success and failure inside an outer transaction', () => {
    const base = { title: 'snapshot', status: 'in_progress', priority: 'normal', sort_order: 0, created_at: 1, updated_at: 1 }
    getDb().transaction(() => {
      expect(() => insertImportedKanbanCard({ ...base, id: 'legacy' })).not.toThrow()
      getDb().exec(`CREATE TEMP TRIGGER fail_import BEFORE INSERT ON kanban_cards WHEN NEW.id='broken'
        BEGIN SELECT RAISE(ABORT, 'injected import failure'); END`)
      expect(() => insertImportedKanbanCard({ ...base, id: 'broken' })).toThrow('injected import failure')
      expect(getDb().prepare('SELECT * FROM kanban_runtime_flags').all()).toEqual([])
      expect(() => insert(getDb(), 'bypass', 'in_progress')).toThrow('execution lane required')
    }).immediate()
    expect(peer.prepare('SELECT * FROM kanban_runtime_flags').all()).toEqual([])
    expect(() => peer.prepare("UPDATE kanban_cards SET title='edited',sort_order=7 WHERE id='legacy'").run()).not.toThrow()
    expect(() => insert(peer, 'new-start', 'in_progress')).toThrow('execution lane required')
  })
  it('allows ordinary planned inserts and title updates without application UDF registration', () => {
    expect(() => insert(peer, 'ordinary')).not.toThrow()
    expect(() => peer.prepare("UPDATE kanban_cards SET title='edited' WHERE id='ordinary'").run()).not.toThrow()
    expect(peer.prepare("SELECT title FROM kanban_cards WHERE id='ordinary'").get()).toEqual({ title: 'edited' })
  })
})
