import { describe, expect, it } from 'vitest'
import {
  decideWorkflowTransition,
  legacyStatusForWorkflowState,
  workflowStateFromLegacyStatus,
} from '../kanban-workflow.js'

describe('canonical kanban workflow', () => {
  it.each([
    ['planned', 'ready'],
    ['in_progress', 'running'],
    ['testing', 'verify'],
    ['waiting', 'blocked'],
    ['done', 'done'],
  ] as const)('derives %s as %s without changing the legacy projection', (legacy, state) => {
    expect(workflowStateFromLegacyStatus(legacy)).toBe(state)
  })

  it.each([
    ['new', 'planned'], ['ready', 'planned'], ['running', 'in_progress'],
    ['verify', 'testing'], ['repair', 'testing'], ['blocked', 'waiting'], ['done', 'done'],
  ] as const)('projects %s to legacy %s', (state, legacy) => {
    expect(legacyStatusForWorkflowState(state)).toBe(legacy)
  })

  it.each([
    ['new', 'ready'], ['new', 'blocked'], ['ready', 'running'], ['ready', 'blocked'],
    ['running', 'verify'], ['running', 'blocked'], ['verify', 'done'], ['verify', 'repair'],
    ['verify', 'blocked'], ['repair', 'verify'], ['repair', 'blocked'], ['blocked', 'ready'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(decideWorkflowTransition(from, to, 0)).toMatchObject({ allowed: true, state: to })
  })

  it.each([['new', 'done'], ['ready', 'verify'], ['running', 'done'], ['blocked', 'done'], ['done', 'ready']] as const)(
    'rejects %s -> %s', (from, to) => expect(decideWorkflowTransition(from, to, 0)).toMatchObject({ allowed: false }),
  )

  it('allows two repair entries, then atomically resolves a third request to blocked', () => {
    expect(decideWorkflowTransition('verify', 'repair', 0)).toEqual({ allowed: true, state: 'repair', repairAttempts: 1 })
    expect(decideWorkflowTransition('verify', 'repair', 1)).toEqual({ allowed: true, state: 'repair', repairAttempts: 2 })
    expect(decideWorkflowTransition('verify', 'repair', 2)).toEqual({
      allowed: true,
      state: 'blocked',
      repairAttempts: 2,
      reason: 'repair_limit_exhausted',
    })
  })
})
