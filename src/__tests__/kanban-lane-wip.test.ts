// Unit tests for the pure §23-24 One Piece Flow / Execution Lane decision
// logic (governance v1.0, TASK-0018). Mirrors the style of
// kanban-dispatch.test.ts: no DB, no HTTP -- just the decision tree.

import { describe, it, expect } from 'vitest'
import { KANBAN_LANES, isValidLane, decideLaneWip, parseLaneWipLimit } from '../kanban-lane-wip.js'

describe('KANBAN_LANES', () => {
  it('matches the §24 Execution Lanes list exactly', () => {
    expect(KANBAN_LANES).toEqual([
      'DEVELOPMENT', 'EMAIL', 'CALENDAR', 'MONITORING', 'MAINTENANCE', 'ADMIN',
    ])
  })
})

describe('isValidLane', () => {
  it('accepts every declared lane', () => {
    for (const lane of KANBAN_LANES) expect(isValidLane(lane)).toBe(true)
  })

  it('rejects unknown strings, null, undefined and empty string', () => {
    expect(isValidLane('development')).toBe(false) // case-sensitive, no silent coercion
    expect(isValidLane('MADE_UP_LANE')).toBe(false)
    expect(isValidLane(null)).toBe(false)
    expect(isValidLane(undefined)).toBe(false)
    expect(isValidLane('')).toBe(false)
  })
})

describe('parseLaneWipLimit', () => {
  it('accepts only integer limits in the registered 0..100 range', () => {
    expect(parseLaneWipLimit('0', 1)).toBe(0)
    expect(parseLaneWipLimit('7', 1)).toBe(7)
    expect(parseLaneWipLimit(100, 1)).toBe(100)
  })

  it.each(['', 'abc', '2x', '1.5', '-1', '101', Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back instead of disabling or corrupting the gate for invalid value %s',
    (value) => expect(parseLaneWipLimit(value, 3)).toBe(3),
  )
})

describe('decideLaneWip', () => {
  it('allows the move when running count is below the limit', () => {
    const d = decideLaneWip('DEVELOPMENT', 0, 1)
    expect(d).toEqual({ allowed: true, lane: 'DEVELOPMENT', runningCount: 0, limit: 1 })
  })

  it('blocks the move when running count already meets the limit (WIP=1 default)', () => {
    const d = decideLaneWip('EMAIL', 1, 1)
    expect(d.allowed).toBe(false)
  })

  it('blocks when running count exceeds the limit', () => {
    const d = decideLaneWip('MONITORING', 3, 1)
    expect(d.allowed).toBe(false)
  })

  it('treats limit <= 0 as unlimited, matching the KANBAN_WIP_* column-limit convention', () => {
    expect(decideLaneWip('ADMIN', 99, 0).allowed).toBe(true)
    expect(decideLaneWip('ADMIN', 99, -1).allowed).toBe(true)
  })

  it('is a pure function: same inputs, same output, no side effects', () => {
    const a = decideLaneWip('MAINTENANCE', 0, 1)
    const b = decideLaneWip('MAINTENANCE', 0, 1)
    expect(a).toEqual(b)
  })
})
