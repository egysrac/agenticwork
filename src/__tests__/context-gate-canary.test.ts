import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONTEXT_GATE_CANARY_COUNTER,
  CONTEXT_GATE_CANARY_EVENT,
  contextGateCanaryRouteDecision,
  resetContextGateCanaryCounterForTests,
  runContextGateCanary,
} from '../context-gate-canary.js'
import { getSettingDefinition } from '../config-registry.js'
import { getDb, initDatabase } from '../db.js'
import { queryTaskObservations } from '../task-observability.js'

describe('TASK-0023 Context Gate canary', () => {
  beforeEach(() => resetContextGateCanaryCounterForTests())

  it('RED/GREEN: is reachable only by the explicit POST path and an enabled rollback toggle', () => {
    expect(getSettingDefinition('CONTEXT_GATE_CANARY_ENABLED')).toMatchObject({
      type: 'boolean', default: '0', requiresRestart: true,
    })
    expect(contextGateCanaryRouteDecision('/api/recall/context-gate-canary', 'POST', false)).toBe('disabled')
    expect(contextGateCanaryRouteDecision('/api/recall/context-gate-canary', 'POST', true)).toBe('run')
    expect(contextGateCanaryRouteDecision('/api/recall/context-gate-canary', 'GET', true)).toBe('not_canary')
    expect(contextGateCanaryRouteDecision('/api/recall', 'GET', true)).toBe('not_canary')
  })

  it('RED/GREEN: makes one bounded, local-only Qwen attempt with deterministic provenance', async () => {
    const gate = vi.fn(async (_query, candidates, opts) => {
      opts.onBatchProvider?.('qwen')
      return [{ id: candidates[0].id, score: 0.9 }]
    })
    const result = await runContextGateCanary(gate as any)

    expect(gate).toHaveBeenCalledOnce()
    const [query, candidates, opts] = gate.mock.calls[0]
    expect(query.length).toBeLessThanOrEqual(100)
    expect(candidates).toHaveLength(3)
    expect(opts).toMatchObject({ topK: 2, localOnly: true, perChunkFallback: false })
    expect(result).toMatchObject({
      event: CONTEXT_GATE_CANARY_EVENT,
      metric: { name: CONTEXT_GATE_CANARY_COUNTER, value: 1 },
      provenance: { task: 'TASK-0023', input: 'server_fixture.v1', provider_policy: 'local_qwen_only' },
      outcome: 'qwen_success',
      output: { ids: ['canary-relevant'], returnedUnfiltered: false },
    })
  })

  it('RED/GREEN: fails open to the complete fixed fixture when local Qwen fails', async () => {
    const result = await runContextGateCanary(vi.fn(async () => []) as any)
    expect(result.outcome).toBe('fail_open')
    expect(result.output).toEqual({
      ids: ['canary-relevant', 'canary-unrelated', 'canary-rollback'],
      returnedUnfiltered: true,
    })
  })

  it('increments the named process-lifetime counter exactly once per explicit run', async () => {
    const gate = vi.fn(async (_query, candidates, opts) => {
      opts.onBatchProvider?.('qwen')
      return [{ id: candidates[0].id, score: 1 }]
    }) as any
    expect((await runContextGateCanary(gate)).metric.value).toBe(1)
    expect((await runContextGateCanary(gate)).metric.value).toBe(2)
  })

  it('RED/GREEN: persists a canary outcome with explicit correlation and session facts', async () => {
    initDatabase(':memory:')
    const gate = vi.fn(async (_query, candidates, opts) => {
      opts.onBatchProvider?.('qwen')
      return [{ id: candidates[0].id, score: 1 }]
    }) as any
    const result = await runContextGateCanary(gate, { db: getDb(), correlationId: 'corr-canary', sessionId: 'session-canary' })
    expect(result.observability?.correlationId).toBe('corr-canary')
    expect(queryTaskObservations(getDb(), 'corr-canary')).toEqual([
      expect.objectContaining({ kind: 'context_gate_measurement', task_id: 'TASK-0023', session_id: 'session-canary', provenance: 'TASK-0023.canary.server_fixture.v1' }),
    ])
  })
})
