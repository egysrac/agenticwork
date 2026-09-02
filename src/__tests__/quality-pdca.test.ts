import { describe, it, expect } from 'vitest'
import { computeQualityMetrics, recommendPdcaAction } from '../quality-pdca.js'

describe('quality-pdca', () => {
  it('empty input -> vacuous success', () => {
    const m = computeQualityMetrics([])
    expect(m).toEqual({ total: 0, succeeded: 0, failed: 0, skipped: 0, successRate: 1, failureRate: 0 })
    expect(recommendPdcaAction(m).action).toBe('maintain')
  })
  it('counts each status correctly', () => {
    const m = computeQualityMetrics([
      { status: 'succeeded', ts: 1 },
      { status: 'failed', ts: 2 },
      { status: 'skipped', ts: 3 },
      { status: 'fired', ts: 4 },
      { status: 'succeeded', ts: 5 },
    ])
    expect(m.total).toBe(5)
    expect(m.succeeded).toBe(2)
    expect(m.failed).toBe(1)
    expect(m.skipped).toBe(1)
    expect(m.successRate).toBeCloseTo(0.4)
    expect(m.failureRate).toBeCloseTo(0.2)
  })
  it('recommendation: maintain when very few runs', () => {
    const m = computeQualityMetrics([{ status: 'failed', ts: 1 }])
    expect(recommendPdcaAction(m).action).toBe('maintain')
  })
  it('recommendation: maintain at >=95%', () => {
    const runs = Array.from({ length: 20 }, (_, i) => ({ status: i < 19 ? 'succeeded' as const : 'failed' as const, ts: i }))
    const m = computeQualityMetrics(runs)
    expect(m.successRate).toBeGreaterThanOrEqual(0.95)
    expect(recommendPdcaAction(m).action).toBe('maintain')
  })
  it('recommendation: review between 80..95%', () => {
    const runs = Array.from({ length: 10 }, (_, i) => ({ status: i < 9 ? 'succeeded' as const : 'failed' as const, ts: i }))
    const m = computeQualityMetrics(runs)
    expect(m.successRate).toBeGreaterThanOrEqual(0.8)
    expect(m.successRate).toBeLessThan(0.95)
    expect(recommendPdcaAction(m).action).toBe('review')
  })
  it('recommendation: revise below 80%', () => {
    const runs = Array.from({ length: 10 }, (_, i) => ({ status: i < 5 ? 'succeeded' as const : 'failed' as const, ts: i }))
    const m = computeQualityMetrics(runs)
    expect(m.successRate).toBeLessThan(0.8)
    expect(recommendPdcaAction(m).action).toBe('revise')
  })
})
