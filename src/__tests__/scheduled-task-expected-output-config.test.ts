import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseExpectedOutputFile } from '../web/scheduled-tasks-io.js'
import { captureExpectedOutput } from '../web/schedule-output-verifier.js'

const ROOT = process.cwd()

describe('scheduled task expectedOutputFile config', () => {
  it('parses the exact allowlisted task/file mappings', () => {
    expect(parseExpectedOutputFile('reggeli-napindito', 'MORNING.md')).toBe('MORNING.md')
    expect(parseExpectedOutputFile('dream-engine', 'DREAM.md')).toBe('DREAM.md')
  })

  it('is opt-in when the field is absent or malformed', () => {
    expect(parseExpectedOutputFile('reggeli-napindito', undefined)).toBeUndefined()
    expect(parseExpectedOutputFile('dream-engine', 42)).toBeUndefined()
  })

  it('rejects arbitrary paths and crossed allowlist mappings', () => {
    expect(parseExpectedOutputFile('reggeli-napindito', '../MORNING.md')).toBeUndefined()
    expect(parseExpectedOutputFile('reggeli-napindito', '/tmp/MORNING.md')).toBeUndefined()
    expect(parseExpectedOutputFile('reggeli-napindito', 'DREAM.md')).toBeUndefined()
    expect(parseExpectedOutputFile('unknown-task', 'MORNING.md')).toBeUndefined()
  })

  it.each([
    ['reggeli-napindito', 'MORNING.md'],
    ['dream-engine', 'DREAM.md'],
  ])('RED/GREEN: candidate config %s explicitly activates its verifier', (taskName, expectedFile) => {
    const configPath = join(ROOT, 'scheduled-tasks', taskName, 'task-config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { expectedOutputFile?: unknown }
    const parsed = parseExpectedOutputFile(taskName, config.expectedOutputFile)

    expect(config).toHaveProperty('expectedOutputFile', expectedFile)
    expect(parsed).toBe(expectedFile)
    expect(captureExpectedOutput(taskName, parsed, ROOT)).toEqual(expect.objectContaining({
      path: join(ROOT, expectedFile),
    }))
  })
})
