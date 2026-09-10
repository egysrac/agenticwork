import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { appendTaskObservation, queryTaskObservations } from '../task-observability.js'
import { aggregateTaskObservability } from '../metrics/task-observability.js'
import { createKanbanCard, getDb, getKanbanCard, initDatabase, transitionKanbanWorkflowState } from '../db.js'

beforeEach(() => initDatabase(':memory:'))

describe('TASK-0030 correlated observability', () => {
  it('RED/GREEN: migrates additively and persists bounded queryable metadata', () => {
    const event = appendTaskObservation(getDb(), { eventId: 'event-1', correlationId: 'corr-1', kind: 'context_gate_measurement',
      taskId: 'TASK-30', sessionId: 'session-1', provenance: 'test.fixture.v1',
      occurredAtMs: 10, metadata: { source: 'canary', outcome: 'qwen_success', candidate_count: 3, returned_count: 1, top_k: 2, returned_unfiltered: false } })
    expect(event.correlation_id).toBe('corr-1')
    expect(queryTaskObservations(getDb(), 'corr-1')).toEqual([event])
    expect(() => appendTaskObservation(getDb(), { kind: 'context_gate_measurement', taskId: null,
      provenance: 'test.fixture.v1', metadata: { content: 'private text' } as any })).toThrow(/unsupported observation metadata/)
  })

  it('RED/GREEN: commits workflow state, legacy audit, and correlated observation atomically', () => {
    createKanbanCard({ id: 'task-1', title: 'task', state: 'ready' })
    transitionKanbanWorkflowState('task-1', 'running', 0, 'dev', 'DEVELOPMENT', undefined,
      { correlationId: 'workflow-correlation', sessionId: 'workflow-session' })
    const audit = getDb().prepare("SELECT correlation_id,observation_event_id FROM kanban_card_events WHERE card_id='task-1'").get() as any
    expect(queryTaskObservations(getDb(), audit.correlation_id)[0]).toMatchObject({ event_id: audit.observation_event_id,
      correlation_id: 'workflow-correlation', task_id: 'task-1', session_id: 'workflow-session' })

    getDb().exec("CREATE TRIGGER reject_observation BEFORE INSERT ON task_observability_events BEGIN SELECT RAISE(ABORT,'reject'); END")
    expect(() => transitionKanbanWorkflowState('task-1', 'verify', 0, 'dev')).toThrow(/reject/)
    expect(getKanbanCard('task-1')).toMatchObject({ state: 'running' })
    expect(getDb().prepare("SELECT COUNT(*) n FROM kanban_card_events WHERE card_id='task-1'").get()).toEqual({ n: 1 })
  })

  it('RED/GREEN: reports null FPY until a complete measured cohort exists', () => {
    appendTaskObservation(getDb(), { kind: 'workflow_transition', taskId: 'incomplete', provenance: 'test.workflow.v1', occurredAtMs: 1,
      transitionSequence: 1,
      metadata: { from_state: 'ready', to_state: 'running', repair_attempts: 0 } })
    expect((aggregateTaskObservability(getDb()).workflow as any)).toMatchObject({ observed_tasks: 1, fpy_eligible_tasks: 0, first_pass_yield: null })
  })

  it('orders a legitimate workflow path by monotonic sequence, never same-time UUID order', () => {
    for (const [eventId, from, to, sequence] of [
      ['a-done', 'verify', 'done', 3], ['b-verify', 'running', 'verify', 2], ['c-running', 'ready', 'running', 1],
    ] as const) {
      appendTaskObservation(getDb(), { eventId, kind: 'workflow_transition', taskId: 'ordered', provenance: 'test.workflow.v1', occurredAtMs: 1000,
        transitionSequence: sequence, metadata: { from_state: from, to_state: to, repair_attempts: 0 } })
    }
    expect((aggregateTaskObservability(getDb()).workflow as any)).toMatchObject({ fpy_eligible_tasks: 1, first_pass_yield: 1,
      tasks: [{ task_id: 'ordered', lead_time_ms: 0 }] })

    for (const [eventId, from, to, sequence] of [
      ['x-done', 'verify', 'done', 1], ['y-verify', 'running', 'verify', 2], ['z-running', 'ready', 'running', 3],
    ] as const) {
      appendTaskObservation(getDb(), { eventId, kind: 'workflow_transition', taskId: 'invalid', provenance: 'test.workflow.v1', occurredAtMs: 1000,
        transitionSequence: sequence, metadata: { from_state: from, to_state: to, repair_attempts: 0 } })
    }
    expect((aggregateTaskObservability(getDb()).workflow as any)).toMatchObject({ observed_tasks: 2, fpy_eligible_tasks: 1 })
  })

  it('RED/GREEN review reproduction: excludes ordered state appearances without a continuous transition chain', () => {
    for (const [from, to, sequence] of [['ready', 'running', 1], ['ready', 'verify', 2], ['ready', 'done', 3]] as const) {
      appendTaskObservation(getDb(), { kind: 'workflow_transition', taskId: 'disconnected', provenance: 'test.workflow.v1', occurredAtMs: sequence,
        transitionSequence: sequence, metadata: { from_state: from, to_state: to, repair_attempts: 0 } })
    }
    for (const [from, to, sequence] of [['ready', 'running', 1], ['running', 'done', 2], ['done', 'verify', 3]] as const) {
      appendTaskObservation(getDb(), { kind: 'workflow_transition', taskId: 'illegal-edge', provenance: 'test.workflow.v1', occurredAtMs: sequence,
        transitionSequence: sequence, metadata: { from_state: from, to_state: to, repair_attempts: 0 } })
    }
    expect((aggregateTaskObservability(getDb()).workflow as any)).toMatchObject({
      observed_tasks: 2, fpy_eligible_tasks: 0, first_pass_successes: 0, first_pass_yield: null, tasks: [],
    })
  })

  it('includes legitimate first-pass and repair workflow paths', () => {
    const paths = {
      first: [['ready', 'running'], ['running', 'verify'], ['verify', 'done']],
      repaired: [['ready', 'running'], ['running', 'verify'], ['verify', 'repair'], ['repair', 'verify'], ['verify', 'done']],
    } as const
    for (const [taskId, path] of Object.entries(paths)) {
      const startedAt = taskId === 'first' ? 10 : 20
      path.forEach(([from, to], index) => appendTaskObservation(getDb(), { kind: 'workflow_transition', taskId,
        provenance: 'test.workflow.v1', occurredAtMs: startedAt + index, transitionSequence: index + 1,
        metadata: { from_state: from, to_state: to, repair_attempts: taskId === 'repaired' && index >= 2 ? 1 : 0 } }))
    }
    expect((aggregateTaskObservability(getDb()).workflow as any)).toMatchObject({
      observed_tasks: 2, fpy_eligible_tasks: 2, first_pass_successes: 1, first_pass_yield: 0.5,
      tasks: [
        { task_id: 'first', first_pass_success: true, lead_time_ms: 2 },
        { task_id: 'repaired', first_pass_success: false, lead_time_ms: 4 },
      ],
    })
  })

  it.each([
    { candidate_count: NaN }, { candidate_count: Infinity }, { returned_count: -1 }, { top_k: 1.5 },
    { returned_unfiltered: 0 }, { query_present: 'true' }, { gate_enabled: null },
  ])('rejects corrupt runtime context metadata %#', (override) => {
    const metadata = { source: 'test', outcome: 'ok', candidate_count: 1, returned_count: 1, top_k: 1,
      returned_unfiltered: false, ...override }
    expect(() => appendTaskObservation(getDb(), { kind: 'context_gate_measurement', taskId: null,
      provenance: 'test.fixture.v1', metadata: metadata as any })).toThrow(/invalid/)
    expect(getDb().prepare('SELECT COUNT(*) n FROM task_observability_events').get()).toEqual({ n: 0 })
  })

  it('skips malformed legacy ledger rows during aggregation', () => {
    getDb().prepare(`INSERT INTO task_observability_events
      (event_id,correlation_id,kind,task_id,session_id,provenance,occurred_at_ms,transition_sequence,metadata_json)
      VALUES ('legacy-bad','legacy','context_gate_measurement',NULL,NULL,'legacy.v1',1,NULL,'{"outcome":null}')`).run()
    expect(() => aggregateTaskObservability(getDb())).not.toThrow()
    expect((aggregateTaskObservability(getDb()).context_gate as any).measurements).toBe(0)
  })

  it('upgrades a pre-TASK-0030 on-disk database without changing or backfilling old rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-0030-upgrade-'))
    const path = join(dir, 'legacy.db')
    getDb().close()
    const legacy = new Database(path)
    legacy.exec(`CREATE TABLE kanban_card_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, from_status TEXT,
      to_status TEXT NOT NULL, actor TEXT, created_at INTEGER NOT NULL);
      INSERT INTO kanban_card_events(card_id,from_status,to_status,actor,created_at)
      VALUES ('old-card','planned','done','old-actor',123);`)
    legacy.close()
    try {
      initDatabase(path)
      expect(getDb().prepare('SELECT id,card_id,from_status,to_status,actor,created_at,correlation_id,observation_event_id FROM kanban_card_events').all())
        .toEqual([{ id: 1, card_id: 'old-card', from_status: 'planned', to_status: 'done', actor: 'old-actor', created_at: 123,
          correlation_id: null, observation_event_id: null }])
      expect(getDb().prepare('SELECT COUNT(*) n FROM task_observability_events').get()).toEqual({ n: 0 })
    } finally {
      getDb().close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
