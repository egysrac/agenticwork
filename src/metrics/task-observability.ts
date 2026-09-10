import Database from 'better-sqlite3'
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { isWorkflowTransitionEdge } from '../kanban-workflow.js'

export const TASK_OBSERVABILITY_METRICS_SCHEMA = 'task-observability-metrics.v1'

type Row = { event_id: string; correlation_id: string; kind: string; task_id: string | null; session_id: string | null; provenance: string; occurred_at_ms: number; transition_sequence: number | null; metadata_json: string }

export function aggregateTaskObservability(db: Database.Database): Record<string, unknown> {
  const rows = db.prepare('SELECT * FROM task_observability_events ORDER BY occurred_at_ms,event_id').all() as Row[]
  const workflows = new Map<string, Array<{ from: string; to: string; repair: number; at: number; sequence: number }>>()
  const gateOutcomes: Record<string, number> = {}
  let correlatedSessions = 0
  for (const row of rows) {
    let metadata: Record<string, unknown>
    try { metadata = JSON.parse(row.metadata_json) as Record<string, unknown> } catch { continue }
    if (row.session_id) correlatedSessions++
    if (row.kind === 'workflow_transition' && row.task_id && Number.isSafeInteger(row.transition_sequence) && row.transition_sequence! >= 0
      && typeof metadata.from_state === 'string' && typeof metadata.to_state === 'string'
      && Number.isSafeInteger(metadata.repair_attempts) && (metadata.repair_attempts as number) >= 0) {
      const events = workflows.get(row.task_id) ?? []
      events.push({ from: metadata.from_state, to: metadata.to_state, repair: metadata.repair_attempts as number,
        at: row.occurred_at_ms, sequence: row.transition_sequence! })
      workflows.set(row.task_id, events)
    } else if (row.kind === 'context_gate_measurement' && typeof metadata.outcome === 'string') {
      const outcome = metadata.outcome
      gateOutcomes[outcome] = (gateOutcomes[outcome] ?? 0) + 1
    }
  }
  const completed = [...workflows.entries()].flatMap(([taskId, events]) => {
    events.sort((a, b) => a.sequence - b.sequence)
    if (new Set(events.map(event => event.sequence)).size !== events.length) return []
    const coherent = events.every((event, index) => isWorkflowTransitionEdge(event.from, event.to)
      && (index === 0 || event.from === events[index - 1].to))
    if (!coherent) return []
    const running = events.find(event => event.to === 'running')
    const verified = running && events.find(event => event.to === 'verify' && event.sequence > running.sequence)
    const done = verified && events.find(event => event.to === 'done' && event.sequence > verified.sequence)
    if (!running || !done || !verified) return []
    const repaired = events.some(event => event.to === 'repair' && event.sequence > running.sequence && event.sequence < done.sequence)
    return [{ task_id: taskId, first_pass_success: !repaired, lead_time_ms: Math.max(0, done.at - running.at) }]
  })
  const successes = completed.filter(task => task.first_pass_success).length
  return {
    schema_version: TASK_OBSERVABILITY_METRICS_SCHEMA,
    scope: 'instrumented_events_only',
    observation_window: rows.length ? { start_ms: rows[0].occurred_at_ms, end_ms: rows.at(-1)!.occurred_at_ms } : null,
    source: { table: 'task_observability_events', rows: rows.length, session_linked_rows: correlatedSessions },
    workflow: {
      observed_tasks: workflows.size,
      fpy_eligible_tasks: completed.length,
      first_pass_successes: successes,
      first_pass_yield: completed.length ? successes / completed.length : null,
      eligibility: 'continuous valid workflow transition chain containing running -> verify -> done; first pass excludes any observed repair in that interval',
      tasks: completed,
    },
    context_gate: { measurements: Object.values(gateOutcomes).reduce((a, b) => a + b, 0), outcome_counts: gateOutcomes },
    limitations: ['No events are backfilled.', 'Incomplete, incoherent, or semantically invalid workflow sequences are excluded from FPY and lead time.', 'Session linkage exists only when an explicit validated session ID was supplied.'],
  }
}

export function writeTaskObservabilityMetrics(databasePath: string, outputPath: string): void {
  if (resolve(databasePath) === resolve(outputPath)) throw new Error('output must differ from source database')
  const db = new Database(resolve(databasePath), { readonly: true, fileMustExist: true })
  const tmp = `${resolve(outputPath)}.tmp-${process.pid}`
  try {
    const output = `${JSON.stringify(aggregateTaskObservability(db), null, 2)}\n`
    mkdirSync(dirname(resolve(outputPath)), { recursive: true })
    writeFileSync(tmp, output, { mode: 0o600 })
    renameSync(tmp, resolve(outputPath))
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* absent */ }
    throw error
  } finally { db.close() }
}
