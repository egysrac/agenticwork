import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const html = readFileSync('web/index.html', 'utf8')
const app = readFileSync('web/app.js', 'utf8')
const en = readFileSync('web/lang/en.js', 'utf8')
const hu = readFileSync('web/lang/hu.js', 'utf8')
const states = ['new', 'ready', 'running', 'verify', 'repair', 'blocked', 'done']

describe('seven-state kanban UI contract', () => {
  it.each(states)('renders the %s column and translations', (state) => {
    expect(html).toContain(`data-status="${state}"`)
    expect(en).toContain(`'kanban.col.${state}'`)
    expect(hu).toContain(`'kanban.col.${state}'`)
  })

  it('submits canonical state and limits detail actions to graph edges', () => {
    expect(app).toContain('KANBAN_WORKFLOW_EDGES')
    expect(app).toContain('body: JSON.stringify({ state: newStatus')
    expect(app).toContain('for (const s of [current, ...(KANBAN_WORKFLOW_EDGES[current] || [])])')
  })

  it('falls back from legacy status when canonical state is absent', () => {
    expect(app).toContain("planned: 'ready'")
    expect(app).toContain("testing: 'verify'")
    expect(app).toContain("waiting: 'blocked'")
  })

  it('creates subtasks in an allowed initial canonical state independent of the parent state', () => {
    expect(app).toContain("parent_id: card.id, state: 'new'")
    expect(app).not.toContain('parent_id: card.id, status: card.status')
    expect(app).toContain("status === 'ready' ? 'ready' : 'new'")
  })

  it('renders archived status from canonical state with all seven labels and colors', () => {
    expect(app).toContain('function archivedWorkflowState(card)')
    expect(app).toContain('card.state || card.workflow_state')
    for (const state of states) {
      expect(app).toContain(`${state}: () => t('kanban.col.${state}')`)
      expect(app).toMatch(new RegExp(`\\b${state}: '#[0-9a-fA-F]{6}'`))
    }
    expect(app).toContain('ARCHIVED_STATE_LABELS[archivedWorkflowState(card)]')
  })
})
