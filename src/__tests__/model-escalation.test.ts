import { describe, it, expect } from 'vitest'
import {
  DEFAULT_ESCALATION_CONFIG,
  selectModel,
  estimateCost,
  describeEscalation,
} from '../model-escalation.js'

describe('model-escalation', () => {
  it('returns L2 below threshold', () => {
    expect(selectModel(100, DEFAULT_ESCALATION_CONFIG)).toBe(DEFAULT_ESCALATION_CONFIG.l2Model)
  })
  it('returns L2 at threshold-1', () => {
    expect(selectModel(DEFAULT_ESCALATION_CONFIG.threshold - 1, DEFAULT_ESCALATION_CONFIG))
      .toBe(DEFAULT_ESCALATION_CONFIG.l2Model)
  })
  it('returns L3 at threshold', () => {
    expect(selectModel(DEFAULT_ESCALATION_CONFIG.threshold, DEFAULT_ESCALATION_CONFIG))
      .toBe(DEFAULT_ESCALATION_CONFIG.l3Model)
  })
  it('returns L3 above threshold', () => {
    expect(selectModel(DEFAULT_ESCALATION_CONFIG.threshold + 5000, DEFAULT_ESCALATION_CONFIG))
      .toBe(DEFAULT_ESCALATION_CONFIG.l3Model)
  })
  it('handles negative and NaN as L2', () => {
    expect(selectModel(-10, DEFAULT_ESCALATION_CONFIG)).toBe(DEFAULT_ESCALATION_CONFIG.l2Model)
    expect(selectModel(Number.NaN, DEFAULT_ESCALATION_CONFIG)).toBe(DEFAULT_ESCALATION_CONFIG.l2Model)
  })
  it('estimateCost uses L2 rates for L2', () => {
    const cost = estimateCost(1000, 2000, DEFAULT_ESCALATION_CONFIG.l2Model)
    const expected = (1000 / 1000) * DEFAULT_ESCALATION_CONFIG.costL2InputPer1k
      + (2000 / 1000) * DEFAULT_ESCALATION_CONFIG.costL2OutputPer1k
    expect(cost).toBeCloseTo(expected, 6)
  })
  it('estimateCost uses L3 rates for L3', () => {
    const cost = estimateCost(1000, 2000, DEFAULT_ESCALATION_CONFIG.l3Model)
    const expected = (1000 / 1000) * DEFAULT_ESCALATION_CONFIG.costL3InputPer1k
      + (2000 / 1000) * DEFAULT_ESCALATION_CONFIG.costL3OutputPer1k
    expect(cost).toBeCloseTo(expected, 6)
  })
  it('estimateCost falls back to L2 for unknown model', () => {
    const cost = estimateCost(1000, 2000, 'mystery-model')
    const expected = (1000 / 1000) * DEFAULT_ESCALATION_CONFIG.costL2InputPer1k
      + (2000 / 1000) * DEFAULT_ESCALATION_CONFIG.costL2OutputPer1k
    expect(cost).toBeCloseTo(expected, 6)
  })
  it('describeEscalation mentions ESCALATED for L3 and kept for L2', () => {
    expect(describeEscalation(5000, DEFAULT_ESCALATION_CONFIG.l2Model)).toMatch(/kept/)
    expect(describeEscalation(9000, DEFAULT_ESCALATION_CONFIG.l3Model)).toMatch(/ESCALATED/)
  })
})
