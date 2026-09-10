import { gateContext } from './context-gate.js'
import type { RelevanceChunk, RelevanceResult } from './qwen-router.js'
import { logger } from './logger.js'
import type Database from 'better-sqlite3'
import { appendTaskObservation } from './task-observability.js'

export const CONTEXT_GATE_CANARY_EVENT = 'context_gate_canary.completed.v1'
export const CONTEXT_GATE_CANARY_COUNTER = 'context_gate_canary_requests_total'
export const CONTEXT_GATE_CANARY_PROVENANCE = Object.freeze({
  task: 'TASK-0023',
  trigger: 'POST /api/recall/context-gate-canary',
  input: 'server_fixture.v1',
  provider_policy: 'local_qwen_only',
})

const QUERY = 'Which memory describes the context gate relevance canary?'
const CANDIDATES: readonly RelevanceChunk[] = Object.freeze([
  Object.freeze({ id: 'canary-relevant', content: 'The context gate canary ranks bounded recall candidates using local Qwen.' }),
  Object.freeze({ id: 'canary-unrelated', content: 'The dashboard colour theme uses neutral shades.' }),
  Object.freeze({ id: 'canary-rollback', content: 'Disable the canary toggle to stop all context gate canary requests.' }),
])

export type ContextGateCanaryOutcome = 'qwen_success' | 'fail_open'

export interface ContextGateCanaryResult {
  event: typeof CONTEXT_GATE_CANARY_EVENT
  metric: { name: typeof CONTEXT_GATE_CANARY_COUNTER; value: number }
  provenance: typeof CONTEXT_GATE_CANARY_PROVENANCE
  outcome: ContextGateCanaryOutcome
  input: { queryChars: number; candidateCount: number; candidateChars: number; topK: number }
  output: { ids: string[]; returnedUnfiltered: boolean }
  observability?: { correlationId: string; eventId: string }
}

let requestCount = 0

// This is intentionally distinct from qwen_relevance_filter calls: it counts
// accepted canary endpoint executions, while qwen-router owns the persistent
// model-filter attempt/failure totals. One canary run normally produces one
// relevance-filter call, but keeping the layers separate preserves meaning if
// gateContext later short-circuits before the model or adds another pass.

export type ContextGateCanaryRouteDecision = 'not_canary' | 'disabled' | 'run'

export function contextGateCanaryRouteDecision(
  path: string,
  method: string,
  enabled: boolean,
): ContextGateCanaryRouteDecision {
  if (path !== '/api/recall/context-gate-canary' || method !== 'POST') return 'not_canary'
  return enabled ? 'run' : 'disabled'
}

export function resetContextGateCanaryCounterForTests(): void {
  requestCount = 0
}

export async function runContextGateCanary(
  gate: typeof gateContext = gateContext,
  observation?: { db: Database.Database; correlationId?: string; sessionId?: string | null },
): Promise<ContextGateCanaryResult> {
  let qwenSucceeded = false
  let results: RelevanceResult[]
  try {
    results = await gate(QUERY, CANDIDATES, {
      topK: 2,
      deterministicMax: 3,
      hardFloor: 1,
      cost: 'low',
      localOnly: true,
      perChunkFallback: false,
      onBatchProvider: provider => { qwenSucceeded = provider === 'qwen' },
    })
  } catch (err) {
    logger.warn({ err, event: CONTEXT_GATE_CANARY_EVENT }, 'context-gate canary: unexpected gate error; failing open')
    results = CANDIDATES.map(c => ({ id: c.id, score: 0 }))
  }

  const returnedUnfiltered = !qwenSucceeded
  if (returnedUnfiltered) results = CANDIDATES.map(c => ({ id: c.id, score: 0 }))
  requestCount += 1
  const result: ContextGateCanaryResult = {
    event: CONTEXT_GATE_CANARY_EVENT,
    metric: { name: CONTEXT_GATE_CANARY_COUNTER, value: requestCount },
    provenance: CONTEXT_GATE_CANARY_PROVENANCE,
    outcome: qwenSucceeded ? 'qwen_success' : 'fail_open',
    input: {
      queryChars: QUERY.length,
      candidateCount: CANDIDATES.length,
      candidateChars: CANDIDATES.reduce((sum, c) => sum + c.content.length, 0),
      topK: 2,
    },
    output: { ids: results.map(r => r.id), returnedUnfiltered },
  }
  if (observation) {
    const event = appendTaskObservation(observation.db, {
      correlationId: observation.correlationId, kind: 'context_gate_measurement',
      taskId: 'TASK-0023', sessionId: observation.sessionId,
      provenance: 'TASK-0023.canary.server_fixture.v1',
      metadata: { source: 'canary', outcome: result.outcome, candidate_count: CANDIDATES.length,
        returned_count: result.output.ids.length, top_k: 2, returned_unfiltered: returnedUnfiltered },
    })
    result.observability = { correlationId: event.correlation_id, eventId: event.event_id }
  }
  logger.info(result, CONTEXT_GATE_CANARY_EVENT)
  return result
}
