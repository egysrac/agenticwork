import { describe, expect, it } from 'vitest'
import { kanbanMoveInstructions } from '../web/routes/kanban.js'

// A card dispatched to an agent used to just say "drag it to done" -- but a
// headless agent cannot drag, and the run left no record on the card. The
// instructions now give the agent the exact curl to post a result summary and
// to hand the card to VERIFY, so the dispatched task's RESULT lands on its own card
// (visible in the dashboard UI) -- the lightweight alternative to per-session
// cards.
describe('kanbanMoveInstructions', () => {
  it('gives the agent the curl to post a result comment AND hand off to VERIFY', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    // Step 1: a human-readable result comment lands on the card.
    expect(out).toContain('/api/kanban/abc123/comments')
    expect(out).toContain('"author":"cody"')
    // Step 2: request verification; DONE is reserved for a successful check.
    expect(out).toContain('/api/kanban/abc123/move')
    expect(out).toContain('"state":"verify"')
    // It must NOT rely on the agent "dragging" the card (a headless agent can't).
    expect(out).not.toContain('húzd "done"-ra')
  })

  // Without an actor the board cannot tell a self-pickup from an assignment, so
  // every move curl the agent is handed names the agent as the mover -- including
  // the in_progress self-pickup, which is the one the dispatcher used to echo back.
  it('names the agent as the actor on every move it is told to make', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out).toContain('"state":"verify","actor":"cody"')
    expect(out).toContain('"state":"running","actor":"cody"')
  })

  it('keeps the bearer token out of the message (reads it at run time)', () => {
    const out = kanbanMoveInstructions('abc123', 'cody')
    expect(out).toContain('$(cat ')
    expect(out).toContain('.dashboard-token')
  })
})
