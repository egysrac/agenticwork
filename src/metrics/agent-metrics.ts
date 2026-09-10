import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export const AGENT_METRICS_SCHEMA_VERSION = 'agent-metrics.v1'
export const AGENT_METRICS_AGGREGATION_VERSION = 'task-0021.sql.v1'

export const AGENT_METRICS_SQL = `WITH agents AS (
  SELECT agent FROM token_usage
  UNION
  SELECT agent FROM task_runs
), token_agg AS (
  SELECT agent,
    COUNT(*) AS row_count,
    COUNT(DISTINCT session_id) AS session_count,
    SUM(input_tokens) AS input_tokens,
    SUM(output_tokens) AS output_tokens,
    SUM(cache_read_tokens) AS cache_read_tokens,
    SUM(cache_creation_tokens) AS cache_creation_tokens,
    SUM(thinking_tokens) AS thinking_tokens,
    SUM(CASE WHEN model IS NOT NULL AND model <> '' THEN 1 ELSE 0 END) AS model_known_rows,
    MIN(timestamp) AS first_timestamp_s,
    MAX(timestamp) AS last_timestamp_s
  FROM token_usage GROUP BY agent
), run_agg AS (
  SELECT agent,
    COUNT(*) AS row_count,
    COUNT(DISTINCT name) AS distinct_task_names,
    MIN(ts) AS first_timestamp_ms,
    MAX(ts) AS last_timestamp_ms
  FROM task_runs GROUP BY agent
)
SELECT agents.agent,
  COALESCE(token_agg.row_count, 0) AS token_row_count,
  COALESCE(token_agg.session_count, 0) AS session_count,
  COALESCE(token_agg.input_tokens, 0) AS input_tokens,
  COALESCE(token_agg.output_tokens, 0) AS output_tokens,
  COALESCE(token_agg.cache_read_tokens, 0) AS cache_read_tokens,
  COALESCE(token_agg.cache_creation_tokens, 0) AS cache_creation_tokens,
  COALESCE(token_agg.thinking_tokens, 0) AS thinking_tokens,
  COALESCE(token_agg.model_known_rows, 0) AS model_known_rows,
  token_agg.first_timestamp_s, token_agg.last_timestamp_s,
  COALESCE(run_agg.row_count, 0) AS task_run_row_count,
  COALESCE(run_agg.distinct_task_names, 0) AS distinct_task_names,
  run_agg.first_timestamp_ms, run_agg.last_timestamp_ms
FROM agents
LEFT JOIN token_agg ON token_agg.agent = agents.agent
LEFT JOIN run_agg ON run_agg.agent = agents.agent
ORDER BY agents.agent COLLATE BINARY`

export const TASK_RUN_STATUS_SQL = `SELECT status, COUNT(*) AS count
FROM task_runs WHERE agent = ?
GROUP BY status ORDER BY status COLLATE BINARY`

const REQUIRED_COLUMNS = {
  token_usage: ['agent', 'session_id', 'timestamp', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'thinking_tokens', 'model'],
  task_runs: ['name', 'agent', 'ts', 'status'],
} as const

const REQUIRED_COLUMN_DEFINITIONS: Record<string, Record<string, { type: 'TEXT' | 'INTEGER'; notNull: boolean }>> = {
  token_usage: {
    agent: { type: 'TEXT', notNull: true }, session_id: { type: 'TEXT', notNull: true },
    timestamp: { type: 'INTEGER', notNull: true }, input_tokens: { type: 'INTEGER', notNull: true },
    output_tokens: { type: 'INTEGER', notNull: true }, cache_read_tokens: { type: 'INTEGER', notNull: true },
    cache_creation_tokens: { type: 'INTEGER', notNull: true }, thinking_tokens: { type: 'INTEGER', notNull: true },
    model: { type: 'TEXT', notNull: false },
  },
  task_runs: {
    name: { type: 'TEXT', notNull: true }, agent: { type: 'TEXT', notNull: true },
    ts: { type: 'INTEGER', notNull: true }, status: { type: 'TEXT', notNull: true },
  },
}

type AggregateRow = Record<string, bigint | string | null> & { agent: string }

const MAX_SAFE_INTEGER_SQL = '9007199254740991'

function toSafeJsonInteger(value: bigint, context: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`unsafe integer ${context}: ${value.toString()} cannot be emitted exactly as a JSON number`)
  }
  return Number(value)
}

function exactJsonFacts(value: unknown, context = 'aggregate'): unknown {
  if (typeof value === 'bigint') return toSafeJsonInteger(value, context)
  if (Array.isArray(value)) return value.map((item, index) => exactJsonFacts(item, `${context}[${index}]`))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, exactJsonFacts(item, `${context}.${key}`)]))
  }
  return value
}

export function assertMetricsSourceSchema(db: Database.Database): void {
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number }>
    const columns = new Map(info.map(row => [row.name, row]))
    const missing = required.filter(column => !columns.has(column))
    if (missing.length) throw new Error(`incompatible database schema: ${table} missing ${missing.join(', ')}`)
    for (const column of required) {
      const actual = columns.get(column)!
      const expected = REQUIRED_COLUMN_DEFINITIONS[table][column]
      if (actual.type.trim().toUpperCase() !== expected.type || (expected.notNull && !actual.notnull)) {
        throw new Error(`incompatible database schema: ${table}.${column} declared constraint must be ${expected.type}${expected.notNull ? ' NOT NULL' : ''}`)
      }
    }
  }
}

const INVALID_SOURCE_QUERIES = [
  {
    table: 'token_usage',
    predicate: `typeof(agent) <> 'text' OR trim(agent) = ''
      OR typeof(session_id) <> 'text' OR trim(session_id) = ''
      OR typeof(timestamp) <> 'integer' OR timestamp < 0
      OR typeof(input_tokens) <> 'integer' OR input_tokens < 0
      OR typeof(output_tokens) <> 'integer' OR output_tokens < 0
      OR typeof(cache_read_tokens) <> 'integer' OR cache_read_tokens < 0
      OR typeof(cache_creation_tokens) <> 'integer' OR cache_creation_tokens < 0
      OR typeof(thinking_tokens) <> 'integer' OR thinking_tokens < 0
      OR (model IS NOT NULL AND typeof(model) <> 'text')`,
  },
  {
    table: 'task_runs',
    predicate: `typeof(name) <> 'text' OR trim(name) = ''
      OR typeof(agent) <> 'text' OR trim(agent) = ''
      OR typeof(ts) <> 'integer' OR ts < 0
      OR typeof(status) <> 'text' OR trim(status) = ''`,
  },
] as const

export function assertMetricsSourceRows(db: Database.Database): void {
  for (const { table, predicate } of INVALID_SOURCE_QUERIES) {
    const invalid = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${predicate}`).get() as { count: number }
    if (invalid.count > 0) throw new Error(`invalid source data: ${table} contains ${invalid.count} malformed row(s)`)
  }
  const unsafeTokenRows = db.prepare(`SELECT COUNT(*) AS count FROM token_usage
    WHERE timestamp > ${MAX_SAFE_INTEGER_SQL}
      OR input_tokens > ${MAX_SAFE_INTEGER_SQL} OR output_tokens > ${MAX_SAFE_INTEGER_SQL}
      OR cache_read_tokens > ${MAX_SAFE_INTEGER_SQL} OR cache_creation_tokens > ${MAX_SAFE_INTEGER_SQL}
      OR thinking_tokens > ${MAX_SAFE_INTEGER_SQL}`).safeIntegers().get() as { count: bigint }
  if (unsafeTokenRows.count > 0n) {
    throw new Error(`unsafe integer source data: token_usage contains ${unsafeTokenRows.count.toString()} row(s) outside the exact JSON integer range`)
  }
  const unsafeTaskRows = db.prepare(`SELECT COUNT(*) AS count FROM task_runs
    WHERE ts > ${MAX_SAFE_INTEGER_SQL}`).safeIntegers().get() as { count: bigint }
  if (unsafeTaskRows.count > 0n) {
    throw new Error(`unsafe integer source data: task_runs contains ${unsafeTaskRows.count.toString()} row(s) outside the exact JSON integer range`)
  }
}

/** A path-independent identity of the validated source tables in the current read snapshot. */
export function metricsSourceSnapshotDigest(db: Database.Database): string {
  const hash = createHash('sha256')
  for (const table of Object.keys(REQUIRED_COLUMNS).sort()) {
    const columns = REQUIRED_COLUMNS[table as keyof typeof REQUIRED_COLUMNS]
    const schema = db.prepare(`PRAGMA table_info(${table})`).all()
    hash.update(`${table}:schema:${JSON.stringify(schema)}\n`)
    const rows = db.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).safeIntegers().all()
    const canonical = rows.map(row => JSON.stringify(row, (_key, value) =>
      typeof value === 'bigint' ? { $integer: value.toString() } : value)).sort()
    for (const row of canonical) hash.update(`${table}:row:${row}\n`)
  }
  return hash.digest('hex')
}

function sourceCounts(db: Database.Database): Record<string, number> {
  const count = (table: string) => {
    const value = (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).safeIntegers().get() as { count: bigint }).count
    return toSafeJsonInteger(value, `aggregate source count for ${table}`)
  }
  return { task_runs: count('task_runs'), token_usage: count('token_usage') }
}

export function aggregateAgentMetrics(db: Database.Database, databasePath: string): unknown[] {
  return db.transaction(() => {
    assertMetricsSourceSchema(db)
    assertMetricsSourceRows(db)
    const counts = sourceCounts(db)
    const statusQuery = db.prepare(TASK_RUN_STATUS_SQL).safeIntegers()
    return (db.prepare(AGENT_METRICS_SQL).safeIntegers().all() as AggregateRow[]).map(row => exactJsonFacts({
    schema_version: AGENT_METRICS_SCHEMA_VERSION,
    aggregation_version: AGENT_METRICS_AGGREGATION_VERSION,
    scope: 'agent_all_time',
    agent: row.agent,
    task_id: null,
    complexity: null,
    result: null,
    llm_calls: row.token_row_count,
    local_model_calls: null,
    cloud_model_calls: null,
    strong_model_calls: null,
    repair_attempts: null,
    files_read: null,
    files_modified: null,
    tests_passed: null,
    tests_failed: null,
    first_pass_success: null,
    lead_time_ms: null,
    observed: {
      token_usage: {
        rows: row.token_row_count,
        sessions: row.session_count,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cache_read_tokens: row.cache_read_tokens,
        cache_creation_tokens: row.cache_creation_tokens,
        thinking_tokens: row.thinking_tokens,
        model_known_rows: row.model_known_rows,
        model_unknown_rows: (row.token_row_count as bigint) - (row.model_known_rows as bigint),
        first_timestamp_s: row.first_timestamp_s,
        last_timestamp_s: row.last_timestamp_s,
      },
      task_runs: {
        rows: row.task_run_row_count,
        distinct_names: row.distinct_task_names,
        status_counts: Object.fromEntries((statusQuery.all(row.agent) as Array<{ status: string; count: bigint }>).map(item => [item.status, item.count])),
        first_timestamp_ms: row.first_timestamp_ms,
        last_timestamp_ms: row.last_timestamp_ms,
      },
    },
    unknown: {
      task_id: 'no reliable task/session foreign key exists between token_usage and task_runs',
      complexity: 'not recorded by either source table',
      result: 'task_runs.status records scheduler events, not verified task outcomes',
      model_tiers: 'local/cloud/strong classification is not recorded; model is nullable',
      repair_attempts: 'verification and repair history is not recorded by either source table',
      files: 'file reads and modifications are not recorded by either source table',
      tests: 'test pass/fail counts are not recorded by either source table',
      first_pass_success: 'first verification outcome cannot be reconstructed',
      lead_time_ms: 'task start and verified completion timestamps are not recorded',
    },
    provenance: {
      database: resolve(databasePath),
      source_tables: ['task_runs', 'token_usage'],
      source_row_counts: counts,
      source_schema: REQUIRED_COLUMNS,
      source_queries: { agent_aggregation: AGENT_METRICS_SQL, task_run_statuses: TASK_RUN_STATUS_SQL },
      ordering: 'agent COLLATE BINARY ascending; task status COLLATE BINARY ascending',
    },
    }, `aggregate for agent ${row.agent}`))
  }).deferred()
}

function canonicalPath(path: string): string {
  let existing = resolve(path)
  const missingParts: string[] = []
  while (true) {
    try {
      return join(realpathSync(existing), ...missingParts.reverse())
    } catch {
      const parent = dirname(existing)
      if (parent === existing) throw new Error(`cannot resolve path: ${path}`)
      missingParts.push(basename(existing))
      existing = parent
    }
  }
}

export function assertDistinctMetricsFiles(databasePath: string, outputPath: string): void {
  const source = canonicalPath(databasePath)
  const output = canonicalPath(outputPath)
  const suffixes = ['-wal', '-shm', '-journal'] as const
  const sourceArtifacts = [...new Set([
    source,
    ...suffixes.map(suffix => `${source}${suffix}`),
    ...suffixes.map(suffix => canonicalPath(`${resolve(databasePath)}${suffix}`)),
  ])]
  let aliasesSourceArtifact = sourceArtifacts.includes(output)
  if (!aliasesSourceArtifact) {
    try {
      const outputStat = statSync(output)
      aliasesSourceArtifact = sourceArtifacts.some(artifact => {
        try {
          const artifactStat = statSync(artifact)
          return artifactStat.dev === outputStat.dev && artifactStat.ino === outputStat.ino
        } catch {
          return false
        }
      })
    } catch {
      // A not-yet-created output has no filesystem identity to compare.
    }
  }
  if (aliasesSourceArtifact) {
    throw new Error('output resolves to a source SQLite artifact (the same file as the source database or one of its sidecars)')
  }
}

export function writeAgentMetrics(databasePath: string, outputPath: string): number {
  assertDistinctMetricsFiles(databasePath, outputPath)
  const db = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    const metrics = aggregateAgentMetrics(db, databasePath)
    const content = metrics.map(metric => JSON.stringify(metric)).join('\n') + (metrics.length ? '\n' : '')
    const absoluteOutput = resolve(outputPath)
    mkdirSync(dirname(absoluteOutput), { recursive: true })
    const temporary = `${absoluteOutput}.tmp-${process.pid}`
    let temporaryCreated = false
    try {
      writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
      temporaryCreated = true
      renameSync(temporary, absoluteOutput)
      temporaryCreated = false
    } finally {
      if (temporaryCreated) {
        try { unlinkSync(temporary) } catch { /* Preserve the original write error. */ }
      }
    }
    return metrics.length
  } finally {
    db.close()
  }
}
