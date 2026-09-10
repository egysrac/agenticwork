import Database from 'better-sqlite3'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BASELINE_TASK_RUN_SQL,
  BASELINE_TOKEN_SQL,
  buildHistoricalBaseline,
  writeHistoricalBaseline,
} from '../metrics/historical-baseline.js'

const directories: string[] = []
const START = '2026-09-01T00:00:00Z'
const END = '2026-09-02T00:00:00Z'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'historical-baseline-'))
  directories.push(directory)
  const dbPath = join(directory, 'production-shaped.sqlite')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE token_usage (
      id INTEGER PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0, thinking_tokens INTEGER NOT NULL DEFAULT 0,
      model TEXT, content_preview TEXT, tool_name TEXT, task_title TEXT, project TEXT
    );
    CREATE TABLE task_runs (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, agent TEXT NOT NULL,
      ts INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'fired'
    );
  `)
  const startSeconds = Date.parse(START) / 1000
  const startMilliseconds = Date.parse(START)
  db.prepare('INSERT INTO token_usage (id,agent,session_id,timestamp,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,thinking_tokens,model) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(1, 'zeta', 'session-1', startSeconds + 10, 11, 7, 5, 3, 2, 'recorded-model')
  db.prepare('INSERT INTO task_runs (id,name,agent,ts,status) VALUES (?,?,?,?,?)')
    .run(1, 'daily-job', 'alpha', startMilliseconds + 20_000, 'fired')
  // Both rows are exactly at the exclusive end and must not enter the baseline.
  db.prepare('INSERT INTO token_usage (id,agent,session_id,timestamp,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,thinking_tokens,model) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(2, 'excluded', 'session-2', Date.parse(END) / 1000, 999, 999, 999, 999, 999, null)
  db.prepare('INSERT INTO task_runs (id,name,agent,ts,status) VALUES (?,?,?,?,?)')
    .run(2, 'excluded-job', 'excluded', Date.parse(END), 'done')
  db.close()
  return { directory, dbPath, outputPath: join(directory, 'out', 'baseline.json') }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('TASK-0022 historical baseline', () => {
  it('is byte-deterministic for the same snapshot, path, and explicit range', () => {
    const { dbPath, outputPath } = fixture()
    writeHistoricalBaseline(dbPath, outputPath, START, END)
    const first = readFileSync(outputPath)
    writeHistoricalBaseline(dbPath, outputPath, START, END)
    expect(readFileSync(outputPath).equals(first)).toBe(true)
  })

  it('carries exact SQL, parameters, and time range on every numeric fact', () => {
    const { dbPath } = fixture()
    const db = new Database(dbPath, { readonly: true })
    const baseline = buildHistoricalBaseline(db, dbPath, START, END) as any
    db.close()

    expect(baseline.observed.agents.map((row: any) => row.agent)).toEqual(['alpha', 'zeta'])
    expect(baseline.observed.source_row_counts.token_usage.value).toBe(1)
    expect(baseline.observed.source_row_counts.task_runs.value).toBe(1)
    expect(baseline.provenance).toMatchObject({
      database: dbPath,
      source_tables: ['task_runs', 'token_usage'],
      agent_selection: {
        parameters: {
          start_s: '1788220800', end_s: '1788307200',
          start_ms: '1788220800000', end_ms: '1788307200000',
        },
        time_range: { start_utc: START, end_utc: END, semantics: '[start,end)' },
      },
    })
    expect(baseline.observed.agents[1].observed.token_usage.input_tokens).toEqual({
      value: 11,
      sql: BASELINE_TOKEN_SQL,
      parameters: { agent: 'zeta', start_s: '1788220800', end_s: '1788307200' },
      time_range: { start_utc: START, end_utc: END, semantics: '[start,end)' },
    })
    expect(baseline.observed.agents[0].observed.task_runs.rows.sql).toBe(BASELINE_TASK_RUN_SQL)

    const numericFacts: any[] = []
    const visit = (value: any): void => {
      if (value && typeof value === 'object' && typeof value.value === 'number') numericFacts.push(value)
      if (value && typeof value === 'object') Object.values(value).forEach(visit)
    }
    visit(baseline)
    expect(numericFacts.length).toBeGreaterThan(10)
    for (const item of numericFacts) {
      expect(item.sql).toEqual(expect.any(String))
      expect(item.parameters).toEqual(expect.any(Object))
      expect(item.time_range).toEqual({ start_utc: START, end_utc: END, semantics: '[start,end)' })
    }
  })

  it('keeps unreconstructable outcomes unknown and does not turn no-data into success or zero', () => {
    const { dbPath } = fixture()
    const db = new Database(dbPath, { readonly: true })
    const baseline = buildHistoricalBaseline(db, dbPath, '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z') as any
    db.close()

    expect(baseline.observed.source_row_counts.token_usage.value).toBe(0)
    expect(baseline.observed.source_row_counts.task_runs.value).toBe(0)
    expect(baseline.observed.agents).toEqual([])
    for (const key of ['verified_outcome', 'repair_attempts', 'first_pass_yield', 'lead_time_ms']) {
      expect(baseline.unknown[key].value).toBeNull()
      expect(baseline.unknown[key].reason).toEqual(expect.any(String))
      expect(baseline.unknown[key].time_range).toEqual({
        start_utc: '2025-01-01T00:00:00Z', end_utc: '2025-01-02T00:00:00Z', semantics: '[start,end)',
      })
    }
  })

  it('rejects implicit, malformed, or reversed ranges', () => {
    const { dbPath } = fixture()
    const db = new Database(dbPath, { readonly: true })
    expect(() => buildHistoricalBaseline(db, dbPath, '2026-09-01', END)).toThrow(/ISO-8601 UTC/)
    expect(() => buildHistoricalBaseline(db, dbPath, END, START)).toThrow(/earlier/)
    expect(() => buildHistoricalBaseline(db, dbPath, START, START)).toThrow(/earlier/)
    expect(() => buildHistoricalBaseline(db, dbPath, '2026-09-01T00:00:00.001Z', END)).toThrow(/whole seconds/)
    expect(() => buildHistoricalBaseline(db, dbPath, '2026-02-29T00:00:00Z', END)).toThrow(/valid exactly representable/)
    db.close()
  })

  it.each(['', '-wal', '-shm', '-journal'])('rejects the source SQLite%s path as output before opening it', suffix => {
    const { dbPath } = fixture()
    expect(() => writeHistoricalBaseline(dbPath, `${dbPath}${suffix}`, START, END)).toThrow(/source SQLite artifact/)
    expect(() => new Database(dbPath, { readonly: true }).close()).not.toThrow()
  })

  it('rejects canonical, symlink, and hardlink aliases of source artifacts', () => {
    const { directory, dbPath } = fixture()
    const symlink = join(directory, 'db-link')
    const hardlink = join(directory, 'db-hardlink')
    symlinkSync(dbPath, symlink)
    linkSync(dbPath, hardlink)
    expect(() => writeHistoricalBaseline(join(directory, '.', 'production-shaped.sqlite'), symlink, START, END)).toThrow(/source SQLite artifact/)
    expect(() => writeHistoricalBaseline(dbPath, hardlink, START, END)).toThrow(/source SQLite artifact/)

    const sidecar = `${dbPath}-journal`
    writeFileSync(sidecar, 'sentinel')
    const sidecarLink = join(directory, 'sidecar-link')
    symlinkSync(sidecar, sidecarLink)
    expect(() => writeHistoricalBaseline(dbPath, sidecarLink, START, END)).toThrow(/source SQLite artifact/)
    expect(readFileSync(sidecar, 'utf8')).toBe('sentinel')
  })

  it('preserves an existing output and cleans temporary output when validation fails', () => {
    const { directory, dbPath, outputPath } = fixture()
    const db = new Database(dbPath)
    db.prepare("UPDATE token_usage SET agent = '' WHERE id = 1").run()
    db.close()
    mkdirSync(join(directory, 'out'))
    writeFileSync(outputPath, 'keep-me')
    expect(() => writeHistoricalBaseline(dbPath, outputPath, START, END)).toThrow(/schema|source data/)
    expect(readFileSync(outputPath, 'utf8')).toBe('keep-me')
    expect(() => readFileSync(`${outputPath}.tmp-${process.pid}`)).toThrow()
    expect(directory).toBeTruthy()
  })

  it('rejects name-compatible schemas with weak types or nullability', () => {
    const directory = mkdtempSync(join(tmpdir(), 'historical-baseline-weak-schema-'))
    directories.push(directory)
    const dbPath = join(directory, 'weak.sqlite')
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE token_usage (agent TEXT, session_id TEXT, timestamp REAL,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
        cache_creation_tokens INTEGER, thinking_tokens INTEGER, model TEXT);
      CREATE TABLE task_runs (name TEXT, agent TEXT, ts INTEGER, status TEXT);
      INSERT INTO token_usage VALUES ('agent', 'session', 1, NULL, 0, 0, 0, 0, NULL);
    `)
    db.close()
    expect(() => writeHistoricalBaseline(dbPath, join(directory, 'out.json'), START, END)).toThrow(/declared constraint/)
    expect(existsSync(join(directory, 'out.json'))).toBe(false)
  })

  it('cleans its temporary file and preserves the target when atomic replacement fails', () => {
    const { dbPath, outputPath } = fixture()
    mkdirSync(outputPath, { recursive: true })
    expect(() => writeHistoricalBaseline(dbPath, outputPath, START, END)).toThrow()
    expect(statSync(outputPath).isDirectory()).toBe(true)
    expect(existsSync(`${outputPath}.tmp-${process.pid}`)).toBe(false)
  })

  it.each([
    ['blank agent', "UPDATE token_usage SET agent = '  ' WHERE id = 1"],
    ['blank session', "UPDATE token_usage SET session_id = '' WHERE id = 1"],
    ['real timestamp', 'UPDATE token_usage SET timestamp = 1.5 WHERE id = 1'],
    ['text token count', "UPDATE token_usage SET input_tokens = 'oops' WHERE id = 1"],
    ['negative token count', 'UPDATE token_usage SET output_tokens = -1 WHERE id = 1'],
    ['blank task name', "UPDATE task_runs SET name = '' WHERE id = 1"],
    ['blank task agent', "UPDATE task_runs SET agent = ' ' WHERE id = 1"],
    ['real task timestamp', 'UPDATE task_runs SET ts = 1.5 WHERE id = 1'],
    ['blank status', "UPDATE task_runs SET status = '' WHERE id = 1"],
  ])('fails closed on malformed raw source: %s', (_label, sql) => {
    const { dbPath } = fixture()
    const writable = new Database(dbPath)
    writable.exec(sql)
    writable.close()
    const db = new Database(dbPath, { readonly: true })
    expect(() => buildHistoricalBaseline(db, dbPath, START, END)).toThrow(/invalid source data/)
    db.close()
  })

  it('rejects unsafe source integers and unsafe aggregates', () => {
    const { dbPath } = fixture()
    const writable = new Database(dbPath)
    writable.prepare('UPDATE token_usage SET input_tokens = ? WHERE id = 1').run(9007199254740992n)
    writable.close()
    const db = new Database(dbPath, { readonly: true })
    expect(() => buildHistoricalBaseline(db, dbPath, START, END)).toThrow(/unsafe integer source data/)
    db.close()

    const second = fixture()
    const aggregateDb = new Database(second.dbPath)
    aggregateDb.prepare('UPDATE token_usage SET input_tokens = ? WHERE id = 1').run(9007199254740991n)
    aggregateDb.prepare('INSERT INTO token_usage (id,agent,session_id,timestamp,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,thinking_tokens,model) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(3, 'zeta', 'session-3', Date.parse(START) / 1000 + 11, 1, 0, 0, 0, 0, null)
    aggregateDb.close()
    const aggregateReadonly = new Database(second.dbPath, { readonly: true })
    expect(() => buildHistoricalBaseline(aggregateReadonly, second.dbPath, START, END)).toThrow(/unsafe integer .*aggregate/)
    aggregateReadonly.close()
  })

  it('records a stable snapshot identity and excludes a concurrent WAL commit', () => {
    const { dbPath } = fixture()
    const writer = new Database(dbPath)
    writer.pragma('journal_mode = WAL')
    const reader = new Database(dbPath, { readonly: true })
    let baseline: any
    reader.transaction(() => {
      reader.prepare('SELECT COUNT(*) FROM token_usage').get()
      writer.prepare('INSERT INTO token_usage (id,agent,session_id,timestamp,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,thinking_tokens,model) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(3, 'later', 'later-session', Date.parse(START) / 1000 + 20, 1, 1, 0, 0, 0, null)
      baseline = buildHistoricalBaseline(reader, dbPath, START, END)
    }).deferred()
    reader.close()
    writer.close()
    expect(baseline.observed.source_row_counts.token_usage.value).toBe(1)
    expect(baseline.provenance.snapshot).toMatchObject({ algorithm: 'sha256', transaction: 'single deferred read transaction' })
    expect(baseline.provenance.snapshot.digest).toMatch(/^[a-f0-9]{64}$/)
  })
})
