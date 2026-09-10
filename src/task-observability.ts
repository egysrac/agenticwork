import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export const TASK_OBSERVABILITY_SCHEMA_VERSION = 'task-observability.v1'
export const TASK_OBSERVABILITY_MAX_METADATA_BYTES = 2048

export type ObservationKind = 'workflow_transition' | 'context_gate_measurement'

export interface TaskObservationInput {
  eventId?: string
  correlationId?: string
  kind: ObservationKind
  taskId: string | null
  sessionId?: string | null
  provenance: string
  occurredAtMs?: number
  transitionSequence?: number | null
  metadata: Record<string, string | number | boolean | null>
}

export interface TaskObservationRow {
  event_id: string
  correlation_id: string
  kind: ObservationKind
  task_id: string | null
  session_id: string | null
  provenance: string
  occurred_at_ms: number
  transition_sequence: number | null
  metadata: Record<string, string | number | boolean | null>
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_PROVENANCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const METADATA_KEYS = new Set([
  'from_state', 'to_state', 'repair_attempts', 'outcome', 'source',
  'candidate_count', 'returned_count', 'top_k', 'returned_unfiltered',
  'query_present', 'gate_enabled',
])

export function migrateTaskObservability(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS task_observability_events (
      event_id TEXT PRIMARY KEY,
      correlation_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('workflow_transition','context_gate_measurement')),
      task_id TEXT,
      session_id TEXT,
      provenance TEXT NOT NULL,
      occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0),
      transition_sequence INTEGER CHECK(transition_sequence IS NULL OR transition_sequence >= 0),
      metadata_json TEXT NOT NULL CHECK(length(metadata_json) <= ${TASK_OBSERVABILITY_MAX_METADATA_BYTES})
    )`)
    try { db.exec('ALTER TABLE task_observability_events ADD COLUMN transition_sequence INTEGER CHECK(transition_sequence IS NULL OR transition_sequence >= 0)') } catch { /* already present */ }
    db.exec('CREATE INDEX IF NOT EXISTS idx_task_observability_correlation ON task_observability_events(correlation_id, occurred_at_ms, event_id)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_task_observability_task ON task_observability_events(task_id, occurred_at_ms, event_id)')
  }).immediate()
}

const WORKFLOW_STATES = new Set(['new', 'ready', 'running', 'verify', 'repair', 'blocked', 'done'])

function nonnegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function validateMetadata(kind: ObservationKind, metadata: Record<string, unknown>): void {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('invalid observation metadata')
  const expected = kind === 'workflow_transition'
    ? new Set(['from_state', 'to_state', 'repair_attempts'])
    : new Set(['source', 'outcome', 'candidate_count', 'returned_count', 'top_k', 'returned_unfiltered', 'query_present', 'gate_enabled'])
  const keys = Object.keys(metadata)
  const unknown = keys.filter(key => !METADATA_KEYS.has(key) || !expected.has(key))
  const required = kind === 'workflow_transition'
    ? expected
    : new Set(['source', 'outcome', 'candidate_count', 'returned_count', 'top_k', 'returned_unfiltered'])
  const missing = [...required].filter(key => !Object.hasOwn(metadata, key))
  if (unknown.length) throw new Error(`unsupported observation metadata: ${unknown.join(', ')}`)
  if (missing.length) throw new Error(`missing observation metadata: ${missing.join(', ')}`)
  if (kind === 'workflow_transition') {
    if (!WORKFLOW_STATES.has(metadata.from_state as string) || !WORKFLOW_STATES.has(metadata.to_state as string)) throw new Error('invalid workflow state metadata')
    if (!nonnegativeSafeInteger(metadata.repair_attempts)) throw new Error('invalid repair_attempts')
    return
  }
  if (typeof metadata.source !== 'string' || !metadata.source || typeof metadata.outcome !== 'string' || !metadata.outcome) throw new Error('invalid context gate string metadata')
  for (const key of ['candidate_count', 'returned_count', 'top_k']) {
    if (!nonnegativeSafeInteger(metadata[key])) throw new Error(`invalid ${key}`)
  }
  for (const key of ['returned_unfiltered', 'query_present', 'gate_enabled']) {
    if (Object.hasOwn(metadata, key) && typeof metadata[key] !== 'boolean') throw new Error(`invalid ${key}`)
  }
}

function safeIdentifier(value: string | null | undefined, field: string): string | null {
  if (value == null) return null
  if (!SAFE_ID.test(value)) throw new Error(`invalid ${field}`)
  return value
}

export function appendTaskObservation(db: Database.Database, input: TaskObservationInput): TaskObservationRow {
  const eventId = safeIdentifier(input.eventId ?? randomUUID(), 'eventId')!
  const correlationId = safeIdentifier(input.correlationId ?? randomUUID(), 'correlationId')!
  const taskId = safeIdentifier(input.taskId, 'taskId')
  const sessionId = safeIdentifier(input.sessionId, 'sessionId')
  if (!SAFE_PROVENANCE.test(input.provenance)) throw new Error('invalid provenance')
  validateMetadata(input.kind, input.metadata)
  const metadataJson = JSON.stringify(input.metadata)
  if (Buffer.byteLength(metadataJson, 'utf8') > TASK_OBSERVABILITY_MAX_METADATA_BYTES) throw new Error('observation metadata exceeds byte limit')
  const occurredAtMs = input.occurredAtMs ?? Date.now()
  if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs < 0) throw new Error('invalid occurredAtMs')
  const transitionSequence = input.transitionSequence ?? null
  if (transitionSequence !== null && !nonnegativeSafeInteger(transitionSequence)) throw new Error('invalid transitionSequence')
  if (input.kind === 'workflow_transition' && transitionSequence === null) throw new Error('workflow transition requires transitionSequence')
  if (input.kind !== 'workflow_transition' && transitionSequence !== null) throw new Error('transitionSequence only applies to workflow transitions')
  db.prepare(`INSERT INTO task_observability_events
    (event_id,correlation_id,kind,task_id,session_id,provenance,occurred_at_ms,transition_sequence,metadata_json)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(eventId, correlationId, input.kind, taskId, sessionId, input.provenance, occurredAtMs, transitionSequence, metadataJson)
  return { event_id: eventId, correlation_id: correlationId, kind: input.kind, task_id: taskId,
    session_id: sessionId, provenance: input.provenance, occurred_at_ms: occurredAtMs, transition_sequence: transitionSequence, metadata: input.metadata }
}

export function queryTaskObservations(db: Database.Database, correlationId: string): TaskObservationRow[] {
  const id = safeIdentifier(correlationId, 'correlationId')!
  return (db.prepare(`SELECT * FROM task_observability_events WHERE correlation_id=?
    ORDER BY occurred_at_ms ASC,event_id ASC`).all(id) as Array<Omit<TaskObservationRow, 'metadata'> & { metadata_json: string }>).map(row => {
      const { metadata_json, ...rest } = row
      return { ...rest, metadata: JSON.parse(metadata_json) }
    })
}
