import { existsSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  return { dir: mkdtempSync(join(tmpdir(), 'marveen-relevance-metrics-')) }
})

vi.mock('../config.js', async original => ({
  ...await original<typeof import('../config.js')>(),
  STORE_DIR: fixture.dir,
}))

import {
  getRelevanceFilterCallCount,
  getRelevanceFilterMetrics,
  registerAnthropicCaller,
  relevanceFilter,
  reloadRelevanceFilterMetricsForTest,
  setOllamaCaller,
} from '../qwen-router.js'
import {
  incrementRelevanceFilterMetricsFile,
  readRelevanceFilterMetricsFile,
  RELEVANCE_FILTER_METRICS_FILE,
} from '../metrics/relevance-filter-metrics.js'

function runCounterWriter(target: string, increments: number): Promise<void> {
  const modulePath = join(process.cwd(), 'src/metrics/relevance-filter-metrics.ts')
  const source = [
    `import(${JSON.stringify(modulePath)}).then(({ incrementRelevanceFilterMetricsFile }) => {`,
    `for (let i = 0; i < ${increments}; i += 1) incrementRelevanceFilterMetricsFile(${JSON.stringify(target)}, i % 3 === 0)`,
    '})',
  ].join('')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--eval', source], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`counter writer exited ${code}: ${stderr}`)))
  })
}

describe('Qwen relevance-filter persistent metrics', () => {
  beforeEach(() => {
    rmSync(RELEVANCE_FILTER_METRICS_FILE, { force: true })
    reloadRelevanceFilterMetricsForTest()
  })

  afterAll(() => rmSync(fixture.dir, { recursive: true, force: true }))

  it('persists successful calls and reloads them after in-memory state is discarded', async () => {
    setOllamaCaller(async () => '[{"id":"a","score":0.9}]')

    await expect(relevanceFilter('query', [{ id: 'a', content: 'answer' }], {
      topK: 1,
      localOnly: true,
      perChunkFallback: false,
    })).resolves.toEqual([{ id: 'a', score: 0.9 }])

    expect(getRelevanceFilterCallCount()).toBe(1)
    expect(getRelevanceFilterMetrics()).toEqual({ schemaVersion: 1, calls: 1, failures: 0 })
    expect(readRelevanceFilterMetricsFile(RELEVANCE_FILTER_METRICS_FILE)).toMatchObject({ calls: 1, failures: 0 })

    reloadRelevanceFilterMetricsForTest()
    expect(getRelevanceFilterCallCount()).toBe(1)
  })

  it('counts a failed local-only batch once even though the filter fails open', async () => {
    setOllamaCaller(async () => { throw new Error('offline') })

    await expect(relevanceFilter('query', [{ id: 'a', content: 'answer' }], {
      topK: 1,
      localOnly: true,
      perChunkFallback: false,
    })).resolves.toEqual([])

    expect(getRelevanceFilterMetrics()).toEqual({ schemaVersion: 1, calls: 1, failures: 1 })
    reloadRelevanceFilterMetricsForTest()
    expect(getRelevanceFilterMetrics()).toEqual({ schemaVersion: 1, calls: 1, failures: 1 })
  })

  it('RED/GREEN: records Qwen failure when a valid Anthropic fallback supplies the relevance result', async () => {
    setOllamaCaller(async () => { throw new Error('offline') })
    registerAnthropicCaller(async () => '[{"id":"a","score":0.8}]')
    const providers: string[] = []

    await expect(relevanceFilter('query', [{ id: 'a', content: 'answer' }], {
      topK: 1,
      perChunkFallback: false,
      onBatchProvider: provider => providers.push(provider),
    })).resolves.toEqual([{ id: 'a', score: 0.8 }])

    expect(providers).toEqual(['anthropic'])
    expect(getRelevanceFilterMetrics()).toEqual({ schemaVersion: 1, calls: 1, failures: 1 })
    reloadRelevanceFilterMetricsForTest()
    expect(getRelevanceFilterMetrics()).toEqual({ schemaVersion: 1, calls: 1, failures: 1 })
  })

  it('does not count an explicitly Anthropic-only relevance call as a Qwen failure', async () => {
    const local = vi.fn(async () => { throw new Error('must not run') })
    setOllamaCaller(local)
    registerAnthropicCaller(async () => '[{"id":"a","score":0.7}]')

    await expect(relevanceFilter('query', [{ id: 'a', content: 'answer' }], {
      topK: 1,
      cost: 'high',
      perChunkFallback: false,
    })).resolves.toEqual([{ id: 'a', score: 0.7 }])

    expect(local).not.toHaveBeenCalled()
    expect(getRelevanceFilterMetrics()).toEqual({ schemaVersion: 1, calls: 1, failures: 0 })
  })

  it('keeps explicit Anthropic-only routing through a malformed batch fallback', async () => {
    const local = vi.fn(async () => { throw new Error('must not run') })
    setOllamaCaller(local)
    let calls = 0
    registerAnthropicCaller(async () => ++calls === 1 ? 'not a relevance batch' : 'releváns')

    await expect(relevanceFilter('query', [{ id: 'a', content: 'answer' }], {
      topK: 1,
      cost: 'high',
    })).resolves.toEqual([{ id: 'a', score: 0.5 }])

    expect(local).not.toHaveBeenCalled()
    expect(getRelevanceFilterMetrics()).toEqual({ schemaVersion: 1, calls: 1, failures: 0 })
  })

  it('counts empty-input invocations without classifying them as failures', async () => {
    await expect(relevanceFilter('query', [])).resolves.toEqual([])
    expect(getRelevanceFilterMetrics()).toEqual({ schemaVersion: 1, calls: 1, failures: 0 })
  })

  it('RED/GREEN: preserves every update from concurrent writer processes', async () => {
    const target = join(fixture.dir, 'concurrent-relevance-metrics.sqlite')
    const writers = 6
    const increments = 25

    await Promise.all(Array.from({ length: writers }, () => runCounterWriter(target, increments)))

    expect(readRelevanceFilterMetricsFile(target)).toEqual({
      schemaVersion: 1,
      calls: writers * increments,
      failures: writers * Math.ceil(increments / 3),
    })
    expect(existsSync(`${target}-wal`)).toBe(false)
    expect(existsSync(`${target}-shm`)).toBe(false)
  }, 40_000)

  it('recovers cleanly after a writer crashes with an uncommitted update', async () => {
    const target = join(fixture.dir, 'crash-relevance-metrics.sqlite')
    incrementRelevanceFilterMetricsFile(target, false)
    const source = [
      `import('better-sqlite3').then(({ default: Database }) => {`,
      `const db = new Database(${JSON.stringify(target)});`,
      "db.exec('BEGIN IMMEDIATE; UPDATE relevance_filter_metrics SET calls = calls + 1000 WHERE singleton = 1');",
      "process.kill(process.pid, 'SIGKILL')",
      '})',
    ].join('')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--eval', source], { cwd: process.cwd(), stdio: 'ignore' })
      child.once('error', reject)
      child.once('exit', (_code, signal) => signal === 'SIGKILL' ? resolve() : reject(new Error(`unexpected crash writer exit: ${signal}`)))
    })

    incrementRelevanceFilterMetricsFile(target, true)

    expect(readRelevanceFilterMetricsFile(target)).toEqual({ schemaVersion: 1, calls: 2, failures: 1 })
    expect(existsSync(`${target}-journal`)).toBe(false)
  })

  it('RED/GREEN: counts total model failure when fail-open returns synthetic zero scores', async () => {
    setOllamaCaller(async () => { throw new Error('offline') })

    await expect(relevanceFilter('query', [
      { id: 'a', content: 'first' },
      { id: 'b', content: 'second' },
    ], { topK: 2, localOnly: true })).resolves.toEqual([
      { id: 'a', score: 0 },
      { id: 'b', score: 0 },
    ])

    expect(getRelevanceFilterMetrics()).toEqual({ schemaVersion: 1, calls: 1, failures: 1 })
  })
})
