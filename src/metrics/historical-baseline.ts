import Database from 'better-sqlite3'
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  assertDistinctMetricsFiles,
  assertMetricsSourceRows,
  assertMetricsSourceSchema,
  metricsSourceSnapshotDigest,
} from './agent-metrics.js'

export const HISTORICAL_BASELINE_SCHEMA_VERSION = 'historical-baseline.v1'
export const HISTORICAL_BASELINE_AGGREGATION_VERSION = 'task-0022.sql.v1'

export const BASELINE_AGENTS_SQL = `SELECT agent FROM (
  SELECT agent FROM token_usage WHERE timestamp >= ? AND timestamp < ?
  UNION
  SELECT agent FROM task_runs WHERE ts >= ? AND ts < ?
) ORDER BY agent COLLATE BINARY`

export const BASELINE_TOKEN_SQL = `SELECT
  COUNT(*) AS rows,
  COUNT(DISTINCT session_id) AS sessions,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
  COALESCE(SUM(thinking_tokens), 0) AS thinking_tokens,
  COALESCE(SUM(CASE WHEN model IS NOT NULL AND model <> '' THEN 1 ELSE 0 END), 0) AS model_known_rows,
  MIN(timestamp) AS first_timestamp_s,
  MAX(timestamp) AS last_timestamp_s
FROM token_usage
WHERE agent = ? AND timestamp >= ? AND timestamp < ?`

export const BASELINE_TASK_RUN_SQL = `SELECT
  COUNT(*) AS rows,
  COUNT(DISTINCT name) AS distinct_names,
  MIN(ts) AS first_timestamp_ms,
  MAX(ts) AS last_timestamp_ms
FROM task_runs
WHERE agent = ? AND ts >= ? AND ts < ?`

export const BASELINE_TASK_STATUS_SQL = `SELECT status, COUNT(*) AS count
FROM task_runs
WHERE agent = ? AND ts >= ? AND ts < ?
GROUP BY status ORDER BY status COLLATE BINARY`

export const BASELINE_SOURCE_COUNT_SQL = {
  token_usage: 'SELECT COUNT(*) AS count FROM token_usage WHERE timestamp >= ? AND timestamp < ?',
  task_runs: 'SELECT COUNT(*) AS count FROM task_runs WHERE ts >= ? AND ts < ?',
} as const

const REQUIRED_COLUMNS = {
  token_usage: ['agent', 'session_id', 'timestamp', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'thinking_tokens', 'model'],
  task_runs: ['name', 'agent', 'ts', 'status'],
} as const

type TimeRange = { start_utc: string; end_utc: string; semantics: '[start,end)' }
type QueryParameters = Record<string, string>

type ExactFact = {
  value: number | null
  sql: string
  parameters: QueryParameters
  time_range: TimeRange
}

function exactInteger(value: bigint | null, context: string): number | null {
  if (value === null) return null
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`unsafe integer aggregate ${context}: ${value.toString()} cannot be emitted exactly as JSON`)
  }
  return Number(value)
}

function parseBoundary(value: string, name: string): { iso: string; epochSeconds: bigint; epochMilliseconds: bigint } {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    throw new Error(`${name} must be an ISO-8601 UTC timestamp with whole seconds (YYYY-MM-DDTHH:mm:ssZ)`)
  }
  const epochMilliseconds = Date.parse(value)
  if (!Number.isSafeInteger(epochMilliseconds) || new Date(epochMilliseconds).toISOString() !== value.replace('Z', '.000Z')) {
    throw new Error(`${name} is not a valid exactly representable UTC timestamp`)
  }
  return { iso: value, epochSeconds: BigInt(epochMilliseconds / 1000), epochMilliseconds: BigInt(epochMilliseconds) }
}

function fact(value: bigint | null, sql: string, parameters: QueryParameters, timeRange: TimeRange, context: string): ExactFact {
  return { value: exactInteger(value, context), sql, parameters, time_range: timeRange }
}

function unknown(reason: string, timeRange: TimeRange) {
  return {
    value: null,
    reason,
    time_range: timeRange,
    evidence: { source_tables: ['task_runs', 'token_usage'], source_schema: REQUIRED_COLUMNS },
  }
}

export function buildHistoricalBaseline(
  db: Database.Database,
  databasePath: string,
  startUtc: string,
  endUtc: string,
): unknown {
  const start = parseBoundary(startUtc, '--start')
  const end = parseBoundary(endUtc, '--end')
  if (start.epochMilliseconds >= end.epochMilliseconds) throw new Error('--start must be earlier than --end')
  const timeRange: TimeRange = { start_utc: start.iso, end_utc: end.iso, semantics: '[start,end)' }
  const tokenRange = { start_s: start.epochSeconds.toString(), end_s: end.epochSeconds.toString() }
  const taskRange = { start_ms: start.epochMilliseconds.toString(), end_ms: end.epochMilliseconds.toString() }

  return db.transaction(() => {
    assertMetricsSourceSchema(db)
    assertMetricsSourceRows(db)
    const snapshotDigest = metricsSourceSnapshotDigest(db)
    const agents = (db.prepare(BASELINE_AGENTS_SQL).all(
      start.epochSeconds, end.epochSeconds, start.epochMilliseconds, end.epochMilliseconds,
    ) as Array<{ agent: string }>).map(({ agent }) => agent)

    const tokenStatement = db.prepare(BASELINE_TOKEN_SQL).safeIntegers()
    const taskStatement = db.prepare(BASELINE_TASK_RUN_SQL).safeIntegers()
    const statusStatement = db.prepare(BASELINE_TASK_STATUS_SQL).safeIntegers()
    const agentRecords = agents.map(agent => {
      const tokenParameters = { agent, ...tokenRange }
      const taskParameters = { agent, ...taskRange }
      const token = tokenStatement.get(agent, start.epochSeconds, end.epochSeconds) as Record<string, bigint | null>
      const task = taskStatement.get(agent, start.epochMilliseconds, end.epochMilliseconds) as Record<string, bigint | null>
      const statusRows = statusStatement.all(agent, start.epochMilliseconds, end.epochMilliseconds) as Array<{ status: string; count: bigint }>
      return {
        agent,
        observed: {
          token_usage: Object.fromEntries(Object.entries(token).map(([key, value]) =>
            [key, fact(value, BASELINE_TOKEN_SQL, tokenParameters, timeRange, `${agent}.token_usage.${key}`)])),
          task_runs: {
            ...Object.fromEntries(Object.entries(task).map(([key, value]) =>
              [key, fact(value, BASELINE_TASK_RUN_SQL, taskParameters, timeRange, `${agent}.task_runs.${key}`)])),
            status_counts: Object.fromEntries(statusRows.map(({ status, count }) => [status,
              fact(count, BASELINE_TASK_STATUS_SQL, taskParameters, timeRange, `${agent}.task_runs.status_counts.${status}`),
            ])),
          },
        },
      }
    })

    const tokenCount = (db.prepare(BASELINE_SOURCE_COUNT_SQL.token_usage).safeIntegers()
      .get(start.epochSeconds, end.epochSeconds) as { count: bigint }).count
    const taskCount = (db.prepare(BASELINE_SOURCE_COUNT_SQL.task_runs).safeIntegers()
      .get(start.epochMilliseconds, end.epochMilliseconds) as { count: bigint }).count

    return {
      schema_version: HISTORICAL_BASELINE_SCHEMA_VERSION,
      aggregation_version: HISTORICAL_BASELINE_AGGREGATION_VERSION,
      scope: 'bounded_historical_raw_facts',
      time_range: timeRange,
      observed: {
        source_row_counts: {
          token_usage: fact(tokenCount, BASELINE_SOURCE_COUNT_SQL.token_usage, tokenRange, timeRange, 'source_row_counts.token_usage'),
          task_runs: fact(taskCount, BASELINE_SOURCE_COUNT_SQL.task_runs, taskRange, timeRange, 'source_row_counts.task_runs'),
        },
        agents: agentRecords,
      },
      unknown: {
        task_id: unknown('no reliable task/session foreign key exists between token_usage and task_runs', timeRange),
        complexity: unknown('not recorded by either source table', timeRange),
        verified_outcome: unknown('task_runs.status records scheduler events, not verified task outcomes', timeRange),
        local_model_calls: unknown('local/cloud/strong classification is not recorded; token_usage.model is nullable', timeRange),
        cloud_model_calls: unknown('local/cloud/strong classification is not recorded; token_usage.model is nullable', timeRange),
        strong_model_calls: unknown('local/cloud/strong classification is not recorded; token_usage.model is nullable', timeRange),
        repair_attempts: unknown('VERIFY/REPAIR history is not recorded by either source table', timeRange),
        files_read: unknown('file reads are not recorded by either source table', timeRange),
        files_modified: unknown('file modifications are not recorded by either source table', timeRange),
        tests_passed: unknown('test outcomes are not recorded by either source table', timeRange),
        tests_failed: unknown('test outcomes are not recorded by either source table', timeRange),
        first_pass_yield: unknown('first verification outcomes cannot be reconstructed; §40 forbids historical inference', timeRange),
        lead_time_ms: unknown('task start and verified completion timestamps are not recorded', timeRange),
      },
      provenance: {
        database: resolve(databasePath),
        snapshot: {
          algorithm: 'sha256',
          digest: snapshotDigest,
          coverage: 'declared schemas and all required raw columns/rows in task_runs and token_usage',
          transaction: 'single deferred read transaction',
        },
        source_tables: ['task_runs', 'token_usage'],
        source_schema: REQUIRED_COLUMNS,
        agent_selection: { sql: BASELINE_AGENTS_SQL, parameters: { ...tokenRange, ...taskRange }, time_range: timeRange },
        ordering: 'agents and task statuses use SQLite COLLATE BINARY ascending; JSON object insertion order is fixed by this aggregation',
      },
    }
  }).deferred()
}

export function writeHistoricalBaseline(databasePath: string, outputPath: string, startUtc: string, endUtc: string): void {
  assertDistinctMetricsFiles(databasePath, outputPath)
  const db = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    const content = `${JSON.stringify(buildHistoricalBaseline(db, databasePath, startUtc, endUtc), null, 2)}\n`
    const absoluteOutput = resolve(outputPath)
    mkdirSync(dirname(absoluteOutput), { recursive: true })
    const temporary = `${absoluteOutput}.tmp-${process.pid}`
    let created = false
    try {
      writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
      created = true
      renameSync(temporary, absoluteOutput)
      created = false
    } finally {
      if (created) try { unlinkSync(temporary) } catch { /* retain original error */ }
    }
  } finally {
    db.close()
  }
}
