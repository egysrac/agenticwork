import Database from 'better-sqlite3'
import { existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { aggregateAgentMetrics, writeAgentMetrics } from '../metrics/agent-metrics.js'

const temporaryDirectories: string[] = []

function fixture(): { directory: string; dbPath: string; outputPath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'agent-metrics-'))
  temporaryDirectories.push(directory)
  const dbPath = join(directory, 'fixture.sqlite')
  const outputPath = join(directory, 'metrics', 'agent_metrics.jsonl')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE token_usage (
      id INTEGER PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
      thinking_tokens INTEGER NOT NULL, model TEXT
    );
    CREATE TABLE task_runs (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, agent TEXT NOT NULL,
      ts INTEGER NOT NULL, status TEXT NOT NULL
    );
  `)
  const tokens = db.prepare('INSERT INTO token_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  tokens.run(1, 'zéta', 's2', 20, 3, 5, 7, 11, 13, null)
  tokens.run(2, 'álom', 's1', 10, 2, 4, 6, 8, 10, 'claude-test')
  tokens.run(3, 'álom', 's1', 12, 20, 40, 60, 80, 100, '')
  const runs = db.prepare('INSERT INTO task_runs VALUES (?, ?, ?, ?, ?)')
  runs.run(1, 'daily', 'álom', 10_000, 'done')
  runs.run(2, 'daily', 'álom', 12_000, 'fired')
  runs.run(3, 'only-run', 'beta', 11_000, 'fired')
  db.close()
  return { directory, dbPath, outputPath }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('TASK-0021 agent metrics aggregation', () => {
  it('GREEN: aggregates exact source facts and writes honest unknowns in binary agent order', () => {
    const { dbPath, outputPath } = fixture()
    expect(writeAgentMetrics(dbPath, outputPath)).toBe(3)
    const records = readFileSync(outputPath, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))

    expect(records.map(record => record.agent)).toEqual(['beta', 'zéta', 'álom'])
    expect(records[2].observed).toEqual({
      token_usage: {
        rows: 2, sessions: 1, input_tokens: 22, output_tokens: 44,
        cache_read_tokens: 66, cache_creation_tokens: 88, thinking_tokens: 110,
        model_known_rows: 1, model_unknown_rows: 1, first_timestamp_s: 10, last_timestamp_s: 12,
      },
      task_runs: {
        rows: 2, distinct_names: 1, status_counts: { done: 1, fired: 1 },
        first_timestamp_ms: 10_000, last_timestamp_ms: 12_000,
      },
    })
    expect(records[0].llm_calls).toBe(0)
    expect(records[0].observed.token_usage.first_timestamp_s).toBeNull()
    expect(records[1].observed.task_runs.first_timestamp_ms).toBeNull()
    expect(records[2]).toMatchObject({
      task_id: null, complexity: null, result: null, repair_attempts: null,
      files_read: null, files_modified: null, tests_passed: null,
      tests_failed: null, first_pass_success: null, lead_time_ms: null,
      provenance: { source_row_counts: { task_runs: 3, token_usage: 3 } },
    })
  })

  it('GREEN: emits deterministic UTF-8 JSONL and replaces output idempotently', () => {
    const { dbPath, outputPath } = fixture()
    writeAgentMetrics(dbPath, outputPath)
    const first = readFileSync(outputPath)
    writeAgentMetrics(dbPath, outputPath)
    const second = readFileSync(outputPath)

    expect(second.equals(first)).toBe(true)
    expect(second.at(-1)).toBe(0x0a)
    expect(second.includes(Buffer.from('zéta', 'utf8'))).toBe(true)
    expect(second.toString('utf8')).not.toContain('\\u00e9')
  })

  it('RED: rejects a source schema that cannot support truthful aggregation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-metrics-invalid-'))
    temporaryDirectories.push(directory)
    const dbPath = join(directory, 'invalid.sqlite')
    const db = new Database(dbPath)
    db.exec('CREATE TABLE token_usage (agent TEXT); CREATE TABLE task_runs (agent TEXT)')
    db.close()
    expect(() => writeAgentMetrics(dbPath, join(directory, 'out.jsonl'))).toThrow(/incompatible database schema/)
  })

  it.each(['same path', 'symlink'])('RED: rejects %s output aliases and preserves the source bytes', alias => {
    const { directory, dbPath } = fixture()
    const before = readFileSync(dbPath)
    const outputPath = alias === 'same path' ? dbPath : join(directory, 'database-link')
    if (alias === 'symlink') symlinkSync(dbPath, outputPath)

    expect(() => writeAgentMetrics(dbPath, outputPath)).toThrow(/same file as the source database/)
    expect(readFileSync(dbPath).equals(before)).toBe(true)
    expect(statSync(dbPath).isFile()).toBe(true)
  })

  it.each(['-wal', '-shm', '-journal'])('RED: rejects the source SQLite %s companion path before changing any source bytes', suffix => {
    const { dbPath } = fixture()
    const before = readFileSync(dbPath)

    expect(() => writeAgentMetrics(dbPath, `${dbPath}${suffix}`)).toThrow(/source SQLite artifact/)
    expect(readFileSync(dbPath).equals(before)).toBe(true)
    expect(existsSync(`${dbPath}${suffix}`)).toBe(false)
  })

  it('RED: rejects a companion path derived from a symlinked source pathname', () => {
    const { directory, dbPath } = fixture()
    const sourceAlias = join(directory, 'source-alias.sqlite')
    symlinkSync(dbPath, sourceAlias)
    const before = readFileSync(dbPath)

    expect(() => writeAgentMetrics(sourceAlias, `${sourceAlias}-journal`)).toThrow(/source SQLite artifact/)
    expect(readFileSync(dbPath).equals(before)).toBe(true)
    expect(existsSync(`${sourceAlias}-journal`)).toBe(false)
  })

  it.each(['-wal', '-shm'])('RED: rejects symlink and hardlink aliases of an existing SQLite %s companion without changing its bytes', suffix => {
    const { directory, dbPath } = fixture()
    const writer = new Database(dbPath)
    writer.pragma('journal_mode = WAL')
    writer.prepare('INSERT INTO task_runs VALUES (?, ?, ?, ?, ?)').run(99, 'pending', 'wal-agent', 99, 'fired')
    const artifactPath = `${dbPath}${suffix}`
    const beforeDatabase = readFileSync(dbPath)
    const beforeArtifact = readFileSync(artifactPath)
    const symlinkPath = join(directory, `symlink${suffix}`)
    const hardlinkPath = join(directory, `hardlink${suffix}`)
    symlinkSync(artifactPath, symlinkPath)
    linkSync(artifactPath, hardlinkPath)

    try {
      expect(() => writeAgentMetrics(dbPath, symlinkPath)).toThrow(/source SQLite artifact/)
      expect(() => writeAgentMetrics(dbPath, hardlinkPath)).toThrow(/source SQLite artifact/)
      expect(readFileSync(dbPath).equals(beforeDatabase)).toBe(true)
      expect(readFileSync(artifactPath).equals(beforeArtifact)).toBe(true)
    } finally {
      writer.close()
    }
  })

  it.each([
    ['text token value', "UPDATE token_usage SET input_tokens = 'not-a-number' WHERE id = 1"],
    ['negative token value', 'UPDATE token_usage SET input_tokens = -1 WHERE id = 1'],
    ['blank token agent', "UPDATE token_usage SET agent = '  ' WHERE id = 1"],
    ['blank session', "UPDATE token_usage SET session_id = '' WHERE id = 1"],
    ['negative token timestamp', 'UPDATE token_usage SET timestamp = -1 WHERE id = 1'],
    ['blank task name', "UPDATE task_runs SET name = '' WHERE id = 1"],
    ['blank task status', "UPDATE task_runs SET status = ' ' WHERE id = 1"],
    ['negative task timestamp', 'UPDATE task_runs SET ts = -1 WHERE id = 1'],
  ])('RED: rejects invalid raw data: %s', (_label, update) => {
    const { directory, dbPath, outputPath } = fixture()
    const db = new Database(dbPath)
    db.exec('PRAGMA ignore_check_constraints = ON')
    db.exec(update)
    db.close()
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, 'existing-output\n', { flag: 'w' })

    expect(() => writeAgentMetrics(dbPath, outputPath)).toThrow(/invalid source data/)
    expect(readFileSync(outputPath, 'utf8')).toBe('existing-output\n')
    expect(existsSync(`${outputPath}.tmp-${process.pid}`)).toBe(false)
  })

  it.each([
    ['token input', 'UPDATE token_usage SET input_tokens = 9007199254740992 WHERE id = 1'],
    ['token timestamp', 'UPDATE token_usage SET timestamp = 9007199254740992 WHERE id = 1'],
    ['task timestamp', 'UPDATE task_runs SET ts = 9007199254740992 WHERE id = 1'],
  ])('RED: rejects unsafe integer source facts exactly: %s', (_label, update) => {
    const { dbPath, outputPath } = fixture()
    const db = new Database(dbPath)
    db.exec(update)
    db.close()
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, 'existing-output\n')

    expect(() => writeAgentMetrics(dbPath, outputPath)).toThrow(/unsafe integer/)
    expect(readFileSync(outputPath, 'utf8')).toBe('existing-output\n')
  })

  it('RED: rejects aggregation overflow beyond JSON safe integers without replacing output', () => {
    const { dbPath, outputPath } = fixture()
    const db = new Database(dbPath)
    db.prepare('UPDATE token_usage SET input_tokens = ? WHERE id = ?').run(4_503_599_627_370_496, 2)
    db.prepare('UPDATE token_usage SET input_tokens = ? WHERE id = ?').run(4_503_599_627_370_496, 3)
    db.close()
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, 'existing-output\n')

    expect(() => writeAgentMetrics(dbPath, outputPath)).toThrow(/unsafe integer aggregate/)
    expect(readFileSync(outputPath, 'utf8')).toBe('existing-output\n')
  })

  it('RED: rejects name-compatible tables without required declared constraints', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-metrics-weak-schema-'))
    temporaryDirectories.push(directory)
    const dbPath = join(directory, 'weak.sqlite')
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE token_usage (agent TEXT, session_id TEXT, timestamp INTEGER,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
        cache_creation_tokens INTEGER, thinking_tokens INTEGER, model TEXT);
      CREATE TABLE task_runs (name TEXT, agent TEXT, ts INTEGER, status TEXT);
    `)
    db.close()
    expect(() => writeAgentMetrics(dbPath, join(directory, 'out.jsonl'))).toThrow(/declared constraint/)
  })

  it('RED: holds one stable WAL read snapshot for provenance and aggregation', () => {
    const { dbPath } = fixture()
    const reader = new Database(dbPath)
    reader.pragma('journal_mode = WAL')
    const writer = new Database(dbPath)
    let injected = false
    const originalPrepare = reader.prepare.bind(reader)
    const instrumented = new Proxy(reader, {
      get(target, property) {
        if (property !== 'prepare') {
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
        return (sql: string) => {
          const statement = originalPrepare(sql)
          if (!sql.includes('COUNT(*) AS count FROM token_usage')) return statement
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty !== 'get') {
                const value = Reflect.get(statementTarget, statementProperty, statementTarget)
                return typeof value === 'function' ? value.bind(statementTarget) : value
              }
              return (...args: unknown[]) => {
                const result = statement.get(...args)
                if (!injected) {
                  injected = true
                  writer.prepare('INSERT INTO token_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                    .run(99, 'late-agent', 'late-session', 99, 1, 1, 1, 1, 1, null)
                }
                return result
              }
            },
          })
        }
      },
    }) as Database.Database

    try {
      const records = aggregateAgentMetrics(instrumented, dbPath) as Array<any>
      expect(records.map(record => record.agent)).not.toContain('late-agent')
      expect(records[0].provenance.source_row_counts.token_usage).toBe(3)
    } finally {
      writer.close()
      reader.close()
    }
  })

  it('GREEN: every output line is independently valid JSON', () => {
    const { dbPath, outputPath } = fixture()
    writeAgentMetrics(dbPath, outputPath)
    const lines = readFileSync(outputPath, 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    for (const line of lines) {
      const record = JSON.parse(line)
      expect(record).toMatchObject({
        schema_version: 'agent-metrics.v1', aggregation_version: 'task-0021.sql.v1',
        scope: 'agent_all_time', agent: expect.any(String), observed: expect.any(Object),
        unknown: expect.any(Object), provenance: expect.any(Object),
      })
    }
  })

  it.each([
    ['--unknown', 'x'],
    ['--db'],
    ['--db', 'one', '--db', 'two'],
    ['--output', 'out.jsonl'],
  ])('RED: CLI rejects invalid arguments: %j', (...cliArgs: unknown[]) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/aggregate-agent-metrics.ts', ...(cliArgs as string[])], {
      cwd: process.cwd(), encoding: 'utf8',
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('Usage:')
  })

  it('RED: removes a temporary file when atomic replacement fails', () => {
    const { directory, dbPath, outputPath } = fixture()
    mkdirSync(outputPath, { recursive: true })
    expect(() => writeAgentMetrics(dbPath, outputPath)).toThrow()
    expect(statSync(outputPath).isDirectory()).toBe(true)
    expect(existsSync(`${outputPath}.tmp-${process.pid}`)).toBe(false)
    expect(existsSync(directory)).toBe(true)
  })

  it('GREEN: reports a nonexistent database without creating output', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agent-metrics-missing-'))
    temporaryDirectories.push(directory)
    const outputPath = join(directory, 'out.jsonl')
    expect(() => writeAgentMetrics(join(directory, 'missing.sqlite'), outputPath)).toThrow()
    expect(existsSync(outputPath)).toBe(false)
  })
})
