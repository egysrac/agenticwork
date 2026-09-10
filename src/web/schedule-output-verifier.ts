import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

export const MORNING_PREP_TASK = 'reggeli-napindito'

export const EXPECTED_OUTPUT_FILES = {
  [MORNING_PREP_TASK]: 'MORNING.md',
  'dream-engine': 'DREAM.md',
} as const

export type ExpectedOutputTaskName = keyof typeof EXPECTED_OUTPUT_FILES

/** Exact-match policy: task config can opt in, but cannot select a path. */
export function allowedExpectedOutputFile(taskName: string, raw: unknown): string | undefined {
  const allowed = EXPECTED_OUTPUT_FILES[taskName as ExpectedOutputTaskName]
  return typeof raw === 'string' && raw === allowed ? allowed : undefined
}

export function expectedOutputPath(taskName: string, projectRoot: string): string | undefined {
  const allowed = EXPECTED_OUTPUT_FILES[taskName as ExpectedOutputTaskName]
  if (!allowed) return undefined
  const root = resolve(projectRoot)
  const output = resolve(root, allowed)
  const rel = relative(root, output)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
    ? output
    : undefined
}

export interface ExpectedOutputSnapshot {
  path: string
  fingerprint: string | null
}

export type ExpectedOutputVerification =
  | { applicable: false }
  | { applicable: true; ok: true; path: string }
  | { applicable: true; ok: false; path: string; reason: 'output-missing' | 'output-empty' | 'output-stale' }

function fingerprint(path: string): string | null {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return null
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex')
    return `${stat.size}:${stat.mtimeMs}:${hash}`
  } catch {
    return null
  }
}

function hasMinimallyValidContent(path: string): boolean {
  try {
    // A briefing containing only whitespace is operationally the same as no
    // briefing. Keep validation deliberately narrow: content semantics remain
    // the preparing agent's job, while the scheduler guarantees a real,
    // non-empty regular-file artifact.
    return statSync(path).isFile() && readFileSync(path, 'utf8').trim().length > 0
  } catch {
    return false
  }
}

/**
 * TASK-0031 deliberately supports a strict set of known file-preparation tasks. This is not
 * a generic post-run shell hook: arbitrary schedules cannot make the runner
 * execute commands or inspect operator-selected paths.
 */
export function captureExpectedOutput(
  taskName: string,
  expectedOutputFile: string | undefined,
  projectRoot: string = PROJECT_ROOT,
): ExpectedOutputSnapshot | null {
  const allowedFile = allowedExpectedOutputFile(taskName, expectedOutputFile)
  if (!allowedFile) return null
  const path = expectedOutputPath(taskName, projectRoot)
  if (!path) return null
  return { path, fingerprint: fingerprint(path) }
}

export function verifyExpectedOutput(
  snapshot: ExpectedOutputSnapshot | null | undefined,
): ExpectedOutputVerification {
  if (!snapshot) return { applicable: false }
  const current = fingerprint(snapshot.path)
  if (current == null) {
    return { applicable: true, ok: false, path: snapshot.path, reason: 'output-missing' }
  }
  if (!hasMinimallyValidContent(snapshot.path)) {
    return { applicable: true, ok: false, path: snapshot.path, reason: 'output-empty' }
  }
  if (current === snapshot.fingerprint) {
    return { applicable: true, ok: false, path: snapshot.path, reason: 'output-stale' }
  }
  return { applicable: true, ok: true, path: snapshot.path }
}
