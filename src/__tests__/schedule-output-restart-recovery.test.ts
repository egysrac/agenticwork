import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const appendRun = vi.fn()
const enqueueRetry = vi.fn()
const deleteObligation = vi.fn()
const durableRows = vi.fn(() => [] as Record<string, unknown>[])

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))
vi.mock('../web/telegram.js', () => ({ sendTelegramMessage: vi.fn(), sendTelegramPhoto: vi.fn() }))
vi.mock('../db.js', () => ({
  appendTaskRun: (...args: unknown[]) => appendRun(...args),
  persistTaskOutputObligation: vi.fn(),
  listTaskOutputObligations: () => durableRows(),
  deleteTaskOutputObligation: (...args: unknown[]) => deleteObligation(...args),
  insertPendingTaskRetryIfNew: (...args: unknown[]) => enqueueRetry(...args),
  listPendingTaskRetries: vi.fn(() => []), deletePendingTaskRetry: vi.fn(),
  updatePendingTaskRetry: vi.fn(), markPendingTaskRetryAlert: vi.fn(),
  clearPendingTaskRetryAlert: vi.fn(), markScheduledTaskKanbanWaiting: vi.fn(),
}))

afterEach(() => vi.clearAllMocks())

describe('reggeli-napindito restart between injection and verification', () => {
  it('recovers the durable baseline and records output-stale plus retry despite a restart', async () => {
    const { MAIN_AGENT_ID, PROJECT_ROOT } = await import('../config.js')
    const root = PROJECT_ROOT
    const output = join(root, 'MORNING.md')
    const original = await import('node:fs').then(({ readFileSync }) => readFileSync(output, 'utf8'))
    writeFileSync(output, 'old morning\n')
    try {
      const { captureExpectedOutput } = await import('../web/schedule-output-verifier.js')
      const baseline = captureExpectedOutput('reggeli-napindito', 'MORNING.md', root)!
      // State left by process A after prompt injection and atomic fired+obligation.
      durableRows.mockReturnValue([{
        task_name: 'reggeli-napindito', agent_name: MAIN_AGENT_ID, injected_at: 1234,
        session: 'jarvis-channels', host: null, working_dir: root, config_dir: null,
        timeout_ms: 300_000, output_path: baseline.path,
        output_fingerprint: baseline.fingerprint,
      }])

      // Importing the runner represents process B: its in-memory watchdog map
      // starts empty, while the SQLite-shaped row above survives.
      vi.resetModules()
      const { recoverTaskOutputObligations, settleExpectedOutput } = await import('../web/schedule-runner.js')
      const [recovered] = recoverTaskOutputObligations()
      settleExpectedOutput(recovered, 2345)

      expect(appendRun).toHaveBeenCalledWith('reggeli-napindito', MAIN_AGENT_ID, 'output-stale')
      expect(enqueueRetry).toHaveBeenCalledWith('reggeli-napindito', MAIN_AGENT_ID, 2345, 'output-stale')
      expect(deleteObligation).toHaveBeenCalledWith('reggeli-napindito', MAIN_AGENT_ID, 1234)
    } finally {
      writeFileSync(output, original)
    }
  }, 15_000)

  it('discards a durable obligation whose path does not match the task allowlist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'morning-restart-invalid-'))
    try {
      durableRows.mockReturnValue([{
        task_name: 'reggeli-napindito', agent_name: 'jarvis', injected_at: 3456,
        session: 'jarvis-channels', host: null, working_dir: root, config_dir: null,
        timeout_ms: 300_000, output_path: join(root, '../arbitrary.md'),
        output_fingerprint: null,
      }])
      vi.resetModules()
      const { recoverTaskOutputObligations } = await import('../web/schedule-runner.js')
      expect(recoverTaskOutputObligations()).toEqual([])
      expect(deleteObligation).toHaveBeenCalledWith('reggeli-napindito', 'jarvis', 3456)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('discards an exact filename rooted in an attacker-controlled persisted working directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'morning-restart-foreign-root-'))
    try {
      durableRows.mockReturnValue([{
        task_name: 'reggeli-napindito', agent_name: 'jarvis', injected_at: 4567,
        session: 'jarvis-channels', host: null, working_dir: root, config_dir: null,
        timeout_ms: 300_000, output_path: join(root, 'MORNING.md'), output_fingerprint: null,
      }])
      vi.resetModules()
      const { recoverTaskOutputObligations } = await import('../web/schedule-runner.js')
      expect(recoverTaskOutputObligations()).toEqual([])
      expect(deleteObligation).toHaveBeenCalledWith('reggeli-napindito', 'jarvis', 4567)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)
})
