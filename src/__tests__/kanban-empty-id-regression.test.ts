import { afterAll, beforeEach, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { rmSync } from 'node:fs'

const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  return { dir: mkdtempSync(`${tmpdir()}/kanban-empty-id-`) }
})
vi.mock('../env.js', () => ({ readEnvFile: () => ({}) }))
vi.mock('../config.js', async original => ({ ...await original<typeof import('../config.js')>(), STORE_DIR: fixture.dir }))

import { countInProgressInLane, createKanbanCard, getDb, initDatabase } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import { OVERRIDES_PATH, reloadOverridesForTest, setOverride } from '../settings-store.js'

let serial = 0
let path: string
beforeEach(() => {
  rmSync(OVERRIDES_PATH, { force: true })
  reloadOverridesForTest()
  path = `${fixture.dir}/${serial++}.db`
  initDatabase(path)
})
afterAll(() => { getDb().close(); rmSync(fixture.dir, { recursive: true, force: true }) })

function seedEmptyIdOccupant() {
  getDb().exec("INSERT INTO kanban_cards(id,title,status,lane,created_at,updated_at) VALUES ('','empty-id occupant','in_progress','EMAIL',1,1)")
}

it('counts an accepted empty-string ID occupant when no self-exclusion was requested', () => {
  seedEmptyIdOccupant()
  expect(countInProgressInLane('EMAIL')).toBe(1)
})

it.each([false, true])('RUNNING transition into a lane occupied by an empty ID observes policy, enforce=%s', async enforce => {
  setOverride('KANBAN_LANE_WIP_ENFORCE', enforce)
  initDatabase(path)
  seedEmptyIdOccupant()
  createKanbanCard({ id: 'candidate', title: 'new work', state: 'ready', lane: 'EMAIL' })
  const state = { code: 0, body: '' }
  const req = Readable.from([Buffer.from(JSON.stringify({ state: 'running', lane: 'EMAIL' }))])
  const res = {
    writeHead(code: number) { state.code = code; return res },
    end(data: unknown) { state.body = String(data) },
    setHeader() {},
  }
  await tryHandleKanban({ req, res, method: 'POST', path: '/api/kanban/candidate/move', url: new URL('http://localhost/api/kanban/candidate/move'), auth: { kind: 'token' } } as any)
  expect(state.code).toBe(enforce ? 409 : 200)
  expect(JSON.parse(state.body)[enforce ? 'decision' : 'wip_warning']).toMatchObject({ runningCount: 1, allowed: false })
})
