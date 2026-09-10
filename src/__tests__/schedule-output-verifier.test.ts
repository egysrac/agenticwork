import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureExpectedOutput,
  verifyExpectedOutput,
} from '../web/schedule-output-verifier.js'

const dirs: string[] = []
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'task-0031-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('TASK-0031 reggeli-napindito expected output', () => {
  it('cannot report success when MORNING.md is absent', () => {
    const snapshot = captureExpectedOutput('reggeli-napindito', 'MORNING.md', tempRoot())
    expect(verifyExpectedOutput(snapshot)).toMatchObject({ ok: false, reason: 'output-missing' })
  })

  it('cannot report success when MORNING.md is newly created but empty', () => {
    const root = tempRoot()
    const snapshot = captureExpectedOutput('reggeli-napindito', 'MORNING.md', root)
    writeFileSync(join(root, 'MORNING.md'), '')
    expect(verifyExpectedOutput(snapshot)).toMatchObject({ ok: false, reason: 'output-empty' })
  })

  it('cannot report success when MORNING.md contains only whitespace', () => {
    const root = tempRoot()
    const snapshot = captureExpectedOutput('reggeli-napindito', 'MORNING.md', root)
    writeFileSync(join(root, 'MORNING.md'), ' \n\t')
    expect(verifyExpectedOutput(snapshot)).toMatchObject({ ok: false, reason: 'output-empty' })
  })

  it('cannot report success when the old MORNING.md remains unchanged', () => {
    const root = tempRoot()
    writeFileSync(join(root, 'MORNING.md'), 'yesterday\n')
    const snapshot = captureExpectedOutput('reggeli-napindito', 'MORNING.md', root)
    expect(verifyExpectedOutput(snapshot)).toMatchObject({ ok: false, reason: 'output-stale' })
  })

  it('recovers safely when MORNING.md content changes, even with a preserved mtime', () => {
    const root = tempRoot()
    const path = join(root, 'MORNING.md')
    writeFileSync(path, 'old briefing\n')
    const snapshot = captureExpectedOutput('reggeli-napindito', 'MORNING.md', root)
    const fixed = new Date('2026-09-09T02:00:00Z')
    writeFileSync(path, 'new briefing\n')
    utimesSync(path, fixed, fixed)
    expect(verifyExpectedOutput(snapshot)).toMatchObject({ ok: true })
  })

  it('is not a generic arbitrary-task output hook and never sends Telegram', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    expect(captureExpectedOutput('operator-shell-task', 'anything.md', tempRoot())).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('is opt-in and rejects arbitrary paths even for an allowlisted task', () => {
    const root = tempRoot()
    expect(captureExpectedOutput('reggeli-napindito', undefined, root)).toBeNull()
    expect(captureExpectedOutput('reggeli-napindito', '../secrets', root)).toBeNull()
    expect(captureExpectedOutput('reggeli-napindito', '/tmp/MORNING.md', root)).toBeNull()
    expect(captureExpectedOutput('reggeli-napindito', 'DREAM.md', root)).toBeNull()
  })
})

describe('TASK-0031 dream-engine expected output', () => {
  it('detects a stale DREAM.md', () => {
    const root = tempRoot()
    writeFileSync(join(root, 'DREAM.md'), 'old dream\n')
    const snapshot = captureExpectedOutput('dream-engine', 'DREAM.md', root)
    expect(snapshot?.path).toBe(join(root, 'DREAM.md'))
    expect(verifyExpectedOutput(snapshot)).toMatchObject({ ok: false, reason: 'output-stale' })
  })

  it('accepts a refreshed DREAM.md', () => {
    const root = tempRoot()
    writeFileSync(join(root, 'DREAM.md'), 'old dream\n')
    const snapshot = captureExpectedOutput('dream-engine', 'DREAM.md', root)
    writeFileSync(join(root, 'DREAM.md'), 'new dream\n')
    expect(verifyExpectedOutput(snapshot)).toMatchObject({ ok: true })
  })
})
