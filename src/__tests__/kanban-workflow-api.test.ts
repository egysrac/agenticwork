import { Readable } from 'node:stream'
import type http from 'node:http'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { createKanbanCard, getDb, getKanbanCard, initDatabase } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  return { dir: mkdtempSync(join(tmpdir(), 'kanban-workflow-api-')) }
})
vi.mock('../env.js', () => ({ readEnvFile: () => ({}) }))
vi.mock('../config.js', async (original) => ({ ...await original<typeof import('../config.js')>(), STORE_DIR: fixture.dir }))
beforeEach(() => initDatabase(':memory:'))
afterAll(() => { getDb().close(); rmSync(fixture.dir, { recursive: true, force: true }) })

async function call(method: string, path: string, body: unknown, headers: http.IncomingHttpHeaders = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  req.headers = headers
  const output = { statusCode: 0, body: '' }
  const res = { writeHead(code: number) { output.statusCode = code; return res }, end(data?: unknown) { output.body = String(data ?? '') }, setHeader() {} } as unknown as http.ServerResponse
  await tryHandleKanban({ req, res, path, method, url: new URL(`http://localhost${path}`), auth: { kind: 'token' } } as RouteContext)
  return { statusCode: output.statusCode, body: JSON.parse(output.body || '{}') }
}

describe('canonical workflow API compatibility', () => {
  it('creates explicit NEW while legacy/default creates remain READY/planned', async () => {
    const modern = await call('POST', '/api/kanban', { title: 'modern', state: 'new' })
    const legacy = await call('POST', '/api/kanban', { title: 'legacy', status: 'planned' })
    expect(getKanbanCard(modern.body.id)).toMatchObject({ state: 'new', status: 'planned' })
    expect(getKanbanCard(legacy.body.id)).toMatchObject({ state: 'ready', status: 'planned' })
  })

  it.each([
    { state: 'ready', status: 'in_progress' },
    { state: 'new', workflow_state: 'ready' },
    { workflow_state: 'new', status: 'planned' },
  ])('rejects inconsistent create aliases %#', async (payload) => {
    const result = await call('POST', '/api/kanban', { title: 'conflict', lane: 'DEVELOPMENT', ...payload })
    expect(result).toMatchObject({ statusCode: 400, body: { code: 'inconsistent_workflow_state' } })
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM kanban_cards').get()).toEqual({ n: 0 })
  })

  it.each([
    { state: 'running' }, { state: 'verify' }, { state: 'repair' }, { state: 'blocked' }, { state: 'done' },
    { status: 'in_progress' }, { status: 'testing' }, { status: 'waiting' }, { status: 'done' },
  ])('rejects non-initial card creation %#', async (payload) => {
    const result = await call('POST', '/api/kanban', { title: 'bypass', lane: 'DEVELOPMENT', ...payload })
    expect(result).toMatchObject({ statusCode: 400, body: { code: 'invalid_initial_state' } })
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM kanban_cards').get()).toEqual({ n: 0 })
  })

  it('accepts canonical state and legacy status on /move', async () => {
    createKanbanCard({ id: 'modern', title: 'modern', state: 'new' })
    expect((await call('POST', '/api/kanban/modern/move', { state: 'ready', actor: 'alex' })).body).toMatchObject({ ok: true, state: 'ready' })
    expect((await call('POST', '/api/kanban/modern/move', { status: 'in_progress', lane: 'DEVELOPMENT', actor: 'alex' })).body).toMatchObject({ ok: true, state: 'running' })
  })

  it.each([
    { 'x-correlation-id': 'invalid id' },
    { 'x-correlation-id': 'forged-correlation', 'x-session-id': 'forged-session', 'x-task-id': 'other-task' },
    { 'x-correlation-id': ['duplicate-one', 'duplicate-two'] },
    { 'x-session-id': 'x'.repeat(1024) },
  ])('ignores untrusted observability headers without changing a valid transition %#', async (headers) => {
    createKanbanCard({ id: 'header-card', title: 'header card', state: 'ready' })
    const result = await call('POST', '/api/kanban/header-card/move', { state: 'running', lane: 'DEVELOPMENT' }, headers)
    expect(result).toMatchObject({ statusCode: 200, body: { ok: true, state: 'running' } })
    const row = getDb().prepare("SELECT correlation_id,session_id,task_id FROM task_observability_events WHERE kind='workflow_transition'").get() as any
    expect(row).toMatchObject({ correlation_id: result.body.correlation_id, session_id: null, task_id: 'header-card' })
    expect(row.correlation_id).not.toBe('forged-correlation')
  })

  it.each([
    { state: 'running', status: 'done', lane: 'DEVELOPMENT' },
    { state: 'ready', workflow_state: 'running', lane: 'DEVELOPMENT' },
  ])('rejects conflicting aliases on /move %#', async (payload) => {
    createKanbanCard({ id: 'card', title: 'card', state: 'ready' })
    const result = await call('POST', '/api/kanban/card/move', payload)
    expect(result).toMatchObject({ statusCode: 400, body: { code: 'inconsistent_workflow_state' } })
    expect(getKanbanCard('card')).toMatchObject({ state: 'ready', status: 'planned' })
  })

  it.each([{ status: 'done' }, { state: 'done' }, { workflow_state: 'done' }])('rejects generic PUT workflow mutation %#', async (payload) => {
    createKanbanCard({ id: 'card', title: 'card', state: 'ready' })
    const result = await call('PUT', '/api/kanban/card', payload)
    expect(result).toMatchObject({ statusCode: 409, body: { code: 'workflow_move_required' } })
    expect(getKanbanCard('card')).toMatchObject({ state: 'ready', status: 'planned' })
  })
})
