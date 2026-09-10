// Pure decision logic for §23-24 One Piece Flow / Execution Lanes
// (governance v1.0, TASK-0018). Kept dependency-free and unit-tested for the
// same reason kanban-dispatch.ts is: the decision tree should be verifiable
// without a DB or HTTP round trip.
//
// Design note: this ships as a CANARY (§37/§68 pattern already used for
// Context Gate in this codebase) -- the route layer decides whether a
// violation actually blocks the move (KANBAN_LANE_WIP_ENFORCE=true) or only
// logs it (default: false, warn-only). This module only answers "would this
// exceed the lane's WIP limit", never "should this request be rejected".

export const KANBAN_LANES = [
  'DEVELOPMENT',
  'EMAIL',
  'CALENDAR',
  'MONITORING',
  'MAINTENANCE',
  'ADMIN',
] as const

export type KanbanLane = (typeof KANBAN_LANES)[number]

export function isValidLane(lane: string | null | undefined): lane is KanbanLane {
  return !!lane && (KANBAN_LANES as readonly string[]).includes(lane)
}

export function parseLaneWipLimit(value: unknown, fallback: number): number {
  const text = typeof value === 'string' ? value.trim() : value
  const parsed = typeof text === 'number' ? text : (typeof text === 'string' && /^\d+$/.test(text) ? Number(text) : Number.NaN)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : fallback
}

export interface LaneWipDecision {
  allowed: boolean
  lane: KanbanLane
  runningCount: number
  limit: number
}

// `runningCount` must already EXCLUDE the card being moved (see
// countInProgressInLane's excludeId param) -- a card moving from planned to
// in_progress is not "competing with itself".
// limit <= 0 means unlimited (mirrors the KANBAN_WIP_* column-limit convention).
export function decideLaneWip(lane: KanbanLane, runningCount: number, limit: number): LaneWipDecision {
  return { allowed: limit <= 0 || runningCount < limit, lane, runningCount, limit }
}
