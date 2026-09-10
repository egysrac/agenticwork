import { Readable } from 'node:stream'
import type http from 'node:http'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  return { dir: mkdtempSync(join(tmpdir(), 'ideas-workflow-')) }
})
vi.mock('../env.js', () => ({ readEnvFile: () => ({}) }))
vi.mock('../config.js', async (original) => ({ ...await original<typeof import('../config.js')>(), STORE_DIR: fixture.dir }))

import { getDb, initDatabase } from '../db.js'
import { tryHandleIdeas } from '../web/routes/ideas.js'
import type { RouteContext } from '../web/routes/types.js'

beforeEach(() => initDatabase(':memory:'))
afterAll(() => { getDb().close(); rmSync(fixture.dir, { recursive: true, force: true }) })

async function call(path: string, payload: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]) as unknown as http.IncomingMessage
  req.headers = {}
  const output = { statusCode: 0, body: '' }
  const res = { writeHead(code: number) { output.statusCode = code; return res }, end(data?: unknown) { output.body = String(data ?? '') }, setHeader() {} } as unknown as http.ServerResponse
  await tryHandleIdeas({ req, res, path, method: 'POST', url: new URL(`http://localhost${path}`), auth: { kind: 'token' } } as RouteContext)
  return { statusCode: output.statusCode, body: JSON.parse(output.body || '{}') }
}

describe('idea promotion under canonical workflow', () => {
  it.each([['detail', 'new'], ['plan', 'ready']])('creates a valid initial %s promotion state without crashing', async (phase, expectedState) => {
    const created = await call('/api/ideas', { title: `Idea ${phase}` })
    expect(created.statusCode).toBe(200)
    const promoted = await call(`/api/ideas/${created.body.id}/promote`, { phase })
    expect(promoted.statusCode).toBe(200)
    expect(getDb().prepare('SELECT workflow_state, status FROM kanban_cards WHERE id=?').get(promoted.body.kanban_id)).toEqual({ workflow_state: expectedState, status: 'planned' })
  })
})
