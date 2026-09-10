import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { logger } from '../logger.js'

export const RELEVANCE_FILTER_METRICS_FILE = join(STORE_DIR, 'qwen-relevance-filter-metrics.sqlite')

export interface RelevanceFilterMetrics {
  schemaVersion: 1
  calls: number
  failures: number
}

const EMPTY_METRICS: RelevanceFilterMetrics = { schemaVersion: 1, calls: 0, failures: 0 }

function validCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function openMetricsDatabase(target: string): Database.Database {
  mkdirSync(dirname(target), { recursive: true })
  const db = new Database(target, { timeout: 10_000 })
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = FULL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS relevance_filter_metrics (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      calls INTEGER NOT NULL CHECK (calls >= 0),
      failures INTEGER NOT NULL CHECK (failures >= 0)
    )
  `)
  return db
}

export function readRelevanceFilterMetricsFile(target: string): RelevanceFilterMetrics {
  const db = openMetricsDatabase(target)
  try {
    const row = db.prepare(
      'SELECT calls, failures FROM relevance_filter_metrics WHERE singleton = 1',
    ).get() as { calls: unknown; failures: unknown } | undefined
    if (!row) return { ...EMPTY_METRICS }
    if (!validCounter(row.calls) || !validCounter(row.failures)) {
      throw new Error('invalid relevance-filter metrics counters')
    }
    return { schemaVersion: 1, calls: row.calls, failures: row.failures }
  } finally {
    db.close()
  }
}

function loadMetrics(): RelevanceFilterMetrics {
  try {
    return readRelevanceFilterMetricsFile(RELEVANCE_FILTER_METRICS_FILE)
  } catch (err) {
    logger.warn({ err, path: RELEVANCE_FILTER_METRICS_FILE }, 'qwen-router: relevance metrics reload failed; using zero counters')
    return { ...EMPTY_METRICS }
  }
}

let metrics = loadMetrics()

// Unit tests must never mutate the checkout's real store. Tests that mock
// STORE_DIR to a sandbox still exercise the complete persistence path.
function persistenceEnabled(): boolean {
  const isRealStore = resolve(RELEVANCE_FILTER_METRICS_FILE) === resolve(PROJECT_ROOT, 'store', 'qwen-relevance-filter-metrics.sqlite')
  return process.env.NODE_ENV !== 'test' || !isRealStore
}

/**
 * A single SQLite UPSERT owns the cross-process read-modify-write. SQLite's
 * file locks prevent lost updates, FULL synchronous mode makes a committed
 * increment durable, and closing in finally releases locks after exceptions.
 */
export function incrementRelevanceFilterMetricsFile(target: string, failed: boolean): RelevanceFilterMetrics {
  const db = openMetricsDatabase(target)
  try {
    const row = db.prepare(`
      INSERT INTO relevance_filter_metrics (singleton, calls, failures)
      VALUES (1, 1, @failureIncrement)
      ON CONFLICT(singleton) DO UPDATE SET
        calls = calls + 1,
        failures = failures + @failureIncrement
      RETURNING calls, failures
    `).get({ failureIncrement: failed ? 1 : 0 }) as { calls: number; failures: number }
    return { schemaVersion: 1, calls: row.calls, failures: row.failures }
  } finally {
    db.close()
  }
}

export function recordRelevanceFilterCall(failed: boolean): void {
  if (!persistenceEnabled()) {
    metrics.calls += 1
    if (failed) metrics.failures += 1
    return
  }
  try {
    metrics = incrementRelevanceFilterMetricsFile(RELEVANCE_FILTER_METRICS_FILE, failed)
  } catch (err) {
    logger.warn({ err, path: RELEVANCE_FILTER_METRICS_FILE }, 'qwen-router: relevance metrics persistence failed')
  }
}

export function getRelevanceFilterCallCount(): number {
  return metrics.calls
}

export function getRelevanceFilterMetrics(): Readonly<RelevanceFilterMetrics> {
  return { ...metrics }
}

/** Re-read the configured metrics database; intended for restart simulation tests. */
export function reloadRelevanceFilterMetricsForTest(): void {
  metrics = loadMetrics()
}
