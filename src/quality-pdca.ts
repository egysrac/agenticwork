// Pure logic for Quality + PDCA (Phase 5).
//
// Takes the raw task-run history (already collected by the schedule-runner)
// and turns it into a small set of metrics a human (or another agent) can act
// on. PDCA = Plan-Do-Check-Act: we "Check" with the metrics and "Act" with a
// one-line recommendation that drives the next iteration of the task
// pipeline.
//
// Dependency-free so it lives next to model-fallback.ts / model-escalation.ts
// and can be unit-tested with no fs, no db, no clock.

export type TaskRunStatus = 'fired' | 'succeeded' | 'failed' | 'skipped'

export interface TaskRun {
  status: TaskRunStatus
  ts: number
}

export interface QualityMetrics {
  total: number
  succeeded: number
  failed: number
  skipped: number
  /** 0..1, or 1 when total==0 (vacuous truth -- nothing has gone wrong yet). */
  successRate: number
  /** 0..1, or 0 when total==0. */
  failureRate: number
}

/** Aggregate raw task-run rows into quality metrics. */
export function computeQualityMetrics(runs: TaskRun[]): QualityMetrics {
  let succeeded = 0
  let failed = 0
  let skipped = 0
  for (const r of runs) {
    if (r.status === 'succeeded') succeeded++
    else if (r.status === 'failed') failed++
    else if (r.status === 'skipped') skipped++
  }
  const total = runs.length
  const successRate = total === 0 ? 1 : succeeded / total
  const failureRate = total === 0 ? 0 : failed / total
  return { total, succeeded, failed, skipped, successRate, failureRate }
}

export type PdcaAction = 'maintain' | 'review' | 'revise'

export interface PdcRecommendation {
  action: PdcaAction
  /** Hungarian one-liner so the dashboard / Telegram relay needs no extra copy. */
  reason: string
}

/**
 * Map the metrics to a PDCA recommendation.
 *   - too few runs to call it     -> maintain (don't overreact on noise)
 *   - >=95% success               -> maintain
 *   - 80..95% success             -> review
 *   - <80%  success               -> revise
 */
export function recommendPdcaAction(metrics: QualityMetrics): PdcRecommendation {
  if (metrics.total < 5) {
    return { action: 'maintain', reason: 'kevés futás a statisztikához (<5), ne reagálj túl' }
  }
  if (metrics.successRate >= 0.95) {
    return { action: 'maintain', reason: `magas sikerességi arány (${(metrics.successRate * 100).toFixed(1)}%)` }
  }
  if (metrics.successRate >= 0.8) {
    return { action: 'review', reason: `közepes sikerességi arány (${(metrics.successRate * 100).toFixed(1)}%), érdemes átnézni` }
  }
  return { action: 'revise', reason: `alacsony sikerességi arány (${(metrics.successRate * 100).toFixed(1)}%), komoly felülvizsgálat szükséges` }
}
