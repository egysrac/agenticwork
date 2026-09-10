// Browser contract for TASK-0018 JIT lane selection. The server is authoritative;
// this guards the three UX entry points so legacy lane-less cards are prompted
// before pickup instead of receiving an opaque 400 after the drop.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const HTML = readFileSync(join(__dirname, '../../web/index.html'), 'utf-8')
const moveBodies = [...APP.matchAll(/fetch\(`\/api\/kanban\/[^`]*\/move`[\s\S]*?JSON\.stringify\(\{([\s\S]*?)\}\)/g)]

function functionSource(name: string): string {
  const marker = APP.indexOf(`function ${name}(`)
  if (marker < 0) throw new Error(`missing ${name}`)
  const start = APP.slice(Math.max(0, marker - 6), marker) === 'async ' ? marker - 6 : marker
  const brace = APP.indexOf('{', start)
  let depth = 0
  for (let i = brace; i < APP.length; i++) {
    if (APP[i] === '{') depth++
    if (APP[i] === '}' && --depth === 0) return APP.slice(start, i + 1)
  }
  throw new Error(`unterminated ${name}`)
}

function moveHarness(promptResult: string | null, fetchImpl: () => Promise<{ ok: boolean }>) {
  const calls = { reload: 0, toast: 0, fetch: 0 }
  const context = {
    window: { prompt: () => promptResult, _marveen: { ownerName: 'owner' } },
    KANBAN_EXECUTION_LANES: ['DEVELOPMENT', 'EMAIL', 'CALENDAR', 'MONITORING', 'MAINTENANCE', 'ADMIN'],
    showToast: () => { calls.toast++ }, t: (s: string) => s,
    fetch: async () => { calls.fetch++; return fetchImpl() },
    loadKanban: async () => { calls.reload++ }, encodeURIComponent, JSON,
    KANBAN_WORKFLOW_EDGES: { ready: ['running', 'blocked'] },
  }
  vm.runInNewContext(`${functionSource('kanbanMoveActor')}\n${functionSource('kanbanWorkflowState')}\n${functionSource('chooseLaneForMove')}\n${functionSource('submitKanbanMove')}\nthis.submit = submitKanbanMove`, context)
  return { calls, submit: (context as any).submit as Function }
}

describe('kanban lane UI contract', () => {
  it('offers all six execution lanes in the card editor', () => {
    expect(HTML).toMatch(/<select id="cardLane">[\s\S]*value="DEVELOPMENT"[\s\S]*value="EMAIL"[\s\S]*value="CALENDAR"[\s\S]*value="MONITORING"[\s\S]*value="MAINTENANCE"[\s\S]*value="ADMIN"[\s\S]*<\/select>/)
    expect(APP).toContain("lane: document.getElementById('cardLane').value || null")
  })

  it('has one shared JIT picker that prompts only for a lane-less transition into RUNNING and rejects cancellation/invalid input', () => {
    expect(APP).toMatch(/function chooseLaneForMove\(card, newStatus\)/)
    expect(APP).toMatch(/newStatus !== 'running' \|\| kanbanWorkflowState\(card\) === 'running'/)
    expect(APP).toMatch(/window\.prompt\([\s\S]*KANBAN_EXECUTION_LANES\.join/)
    expect(APP).toMatch(/if \(!KANBAN_EXECUTION_LANES\.includes\(chosen\)\)[\s\S]*return null/)
  })

  it('submits the selected canonical initial state; direct RUNNING creation is rejected by the API workflow authority', () => {
    expect(APP).toMatch(/const createStatus = document\.getElementById\('cardEditStatus'\)\.value[\s\S]*data\.state = createStatus/)
    expect(APP).not.toMatch(/createStatus === 'running' && !data\.lane/)
  })

  it('desktop drag checks the HTTP result so a server-side block is not treated as success', () => {
    const desktopDnd = APP.slice(APP.indexOf('function wireKanbanColumnDnD'), APP.indexOf('columns.forEach(wireKanbanColumnDnD)'))
    expect(desktopDnd).toMatch(/await submitKanbanMove\(draggedCard, newStatus, sortOrder\)/)
    const submit = functionSource('submitKanbanMove')
    expect(submit).toMatch(/const r = await fetch\(/)
    expect(submit).toMatch(/if \(!r\.ok\) throw new Error\('move failed'\)/)
  })

  it('all three /move paths resolve a lane before fetch, block cleanly on null, and send the chosen lane', () => {
    expect(moveBodies.length).toBe(3)
    expect((APP.match(/chooseLaneForMove\(/g) || []).length).toBe(4) // definition + 3 callers
    expect((APP.match(/resolvedLane === null/g) || []).length).toBe(3)
    for (const [, body] of moveBodies) expect(body).toMatch(/lane: resolvedLane/)
  })

  it('behaviorally reloads the board after desktop lane cancellation or HTTP failure', async () => {
    const card = { id: 'card-1', status: 'planned', state: 'ready', lane: null }
    const cancelled = moveHarness(null, async () => ({ ok: true }))
    await cancelled.submit(card, 'running', 0)
    expect(cancelled.calls).toMatchObject({ reload: 1, fetch: 0 })

    const failed = moveHarness('DEVELOPMENT', async () => ({ ok: false }))
    await failed.submit(card, 'running', 0)
    expect(failed.calls).toMatchObject({ reload: 1, fetch: 1, toast: 1 })
  })

  it('updates the detail card lane after a successful JIT pickup', () => {
    const detail = functionSource('showCardDetail')
    expect(detail).toMatch(/card\.state = newVal[\s\S]*card\.lane = resolvedLane/)
  })
})
