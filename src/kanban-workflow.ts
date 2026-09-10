export const WORKFLOW_STATES = ['new', 'ready', 'running', 'verify', 'repair', 'blocked', 'done'] as const
export type WorkflowState = typeof WORKFLOW_STATES[number]

export const LEGACY_KANBAN_STATUSES = ['planned', 'in_progress', 'testing', 'waiting', 'done'] as const
export type LegacyKanbanStatus = typeof LEGACY_KANBAN_STATUSES[number]

const LEGACY_TO_WORKFLOW: Record<LegacyKanbanStatus, WorkflowState> = {
  planned: 'ready',
  in_progress: 'running',
  testing: 'verify',
  waiting: 'blocked',
  done: 'done',
}

const WORKFLOW_TO_LEGACY: Record<WorkflowState, LegacyKanbanStatus> = {
  new: 'planned',
  ready: 'planned',
  running: 'in_progress',
  verify: 'testing',
  repair: 'testing',
  blocked: 'waiting',
  done: 'done',
}

const EDGES: Record<WorkflowState, readonly WorkflowState[]> = {
  new: ['ready', 'blocked'],
  ready: ['running', 'blocked'],
  running: ['verify', 'blocked'],
  verify: ['done', 'repair', 'blocked'],
  repair: ['verify', 'blocked'],
  blocked: ['ready'],
  done: [],
}

export function isWorkflowTransitionEdge(from: unknown, to: unknown): from is WorkflowState {
  return isWorkflowState(from) && isWorkflowState(to) && EDGES[from].includes(to)
}

export function isWorkflowState(value: unknown): value is WorkflowState {
  return typeof value === 'string' && (WORKFLOW_STATES as readonly string[]).includes(value)
}

export function isLegacyKanbanStatus(value: unknown): value is LegacyKanbanStatus {
  return typeof value === 'string' && (LEGACY_KANBAN_STATUSES as readonly string[]).includes(value)
}

export function workflowStateFromLegacyStatus(status: LegacyKanbanStatus): WorkflowState {
  return LEGACY_TO_WORKFLOW[status]
}

export function legacyStatusForWorkflowState(state: WorkflowState): LegacyKanbanStatus {
  return WORKFLOW_TO_LEGACY[state]
}

/** Whether a canonical state is losslessly representable by a legacy status.
 * `new`/`ready` and `verify`/`repair` deliberately share legacy buckets. */
export function isWorkflowStateCompatibleWithLegacyStatus(state: WorkflowState, status: LegacyKanbanStatus): boolean {
  return legacyStatusForWorkflowState(state) === status
}

export class WorkflowCreationError extends Error {
  constructor(public readonly code: 'inconsistent_workflow_state' | 'invalid_initial_state', message: string) {
    super(message)
  }
}

/** Public card creation starts at NEW, or READY for the pre-canonical default.
 * Legacy `planned` is the sole safe status compatibility value: the other old
 * statuses describe graph transitions and must not become unaudited inserts. */
export function resolveInitialWorkflowState(input: {
  state?: unknown
  workflow_state?: unknown
  status?: unknown
}): 'new' | 'ready' {
  const canonical = [input.state, input.workflow_state].filter(value => value !== undefined)
  for (const value of canonical) {
    if (!isWorkflowState(value)) {
      throw new WorkflowCreationError('invalid_initial_state', `Invalid initial workflow state: ${String(value)}`)
    }
  }
  if (canonical.length === 2 && canonical[0] !== canonical[1]) {
    throw new WorkflowCreationError('inconsistent_workflow_state', 'Conflicting workflow state fields')
  }
  if (input.status !== undefined && !isLegacyKanbanStatus(input.status)) {
    throw new WorkflowCreationError('invalid_initial_state', `Invalid legacy status: ${String(input.status)}`)
  }
  const canonicalState = canonical[0] as WorkflowState | undefined
  const legacyState = input.status === undefined ? undefined : workflowStateFromLegacyStatus(input.status as LegacyKanbanStatus)
  if (canonicalState !== undefined && legacyState !== undefined && canonicalState !== legacyState) {
    throw new WorkflowCreationError('inconsistent_workflow_state', 'Conflicting workflow state and legacy status')
  }
  const state = canonicalState ?? legacyState ?? 'ready'
  if (state !== 'new' && state !== 'ready') {
    const source = canonicalState === undefined ? 'legacy status' : 'initial workflow state'
    throw new WorkflowCreationError('invalid_initial_state', `Invalid ${source}: creation may only start in new or ready`)
  }
  return state
}

export function resolveWorkflowTransitionState(input: {
  state?: unknown
  workflow_state?: unknown
  status?: unknown
}): WorkflowState {
  const supplied: WorkflowState[] = []
  for (const value of [input.state, input.workflow_state]) {
    if (value === undefined) continue
    if (!isWorkflowState(value)) {
      throw new WorkflowCreationError('invalid_initial_state', `Invalid workflow state: ${String(value)}`)
    }
    supplied.push(value)
  }
  if (input.status !== undefined) {
    if (!isLegacyKanbanStatus(input.status)) {
      throw new WorkflowCreationError('invalid_initial_state', `Invalid legacy status: ${String(input.status)}`)
    }
    supplied.push(workflowStateFromLegacyStatus(input.status))
  }
  if (supplied.length === 0) {
    throw new WorkflowCreationError('invalid_initial_state', 'Workflow state or legacy status required')
  }
  if (!supplied.every(value => value === supplied[0])) {
    throw new WorkflowCreationError('inconsistent_workflow_state', 'Conflicting workflow state fields')
  }
  return supplied[0]
}

export type WorkflowTransitionDecision =
  | { allowed: false; state: WorkflowState; repairAttempts: number; reason: 'invalid_transition' }
  | { allowed: true; state: WorkflowState; repairAttempts: number; reason?: 'repair_limit_exhausted' }

export function decideWorkflowTransition(
  from: WorkflowState,
  requested: WorkflowState,
  repairAttempts: number,
): WorkflowTransitionDecision {
  if (!EDGES[from].includes(requested)) {
    return { allowed: false, state: from, repairAttempts, reason: 'invalid_transition' }
  }
  if (requested !== 'repair') return { allowed: true, state: requested, repairAttempts }
  if (repairAttempts >= 2) {
    return { allowed: true, state: 'blocked', repairAttempts, reason: 'repair_limit_exhausted' }
  }
  return { allowed: true, state: 'repair', repairAttempts: repairAttempts + 1 }
}
