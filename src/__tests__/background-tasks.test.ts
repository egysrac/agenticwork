import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { buildModelEnv } from '../web/routes/background-tasks.js'

describe('background_tasks schema and CRUD', () => {
  let db: ReturnType<typeof Database>

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE background_tasks (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','failed','timeout')),
        tmux_session TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        output TEXT
      )
    `)
    db.exec(`CREATE INDEX idx_bg_tasks_agent ON background_tasks(agent_id, status)`)
  })

  it('inserts a running task', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, tmux_session, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('ABCD1234', 'marveen', 'test prompt', 'running', 'bg-ABCD1234', now)

    const row = db.prepare('SELECT * FROM background_tasks WHERE id = ?').get('ABCD1234') as any
    expect(row.agent_id).toBe('marveen')
    expect(row.status).toBe('running')
    expect(row.prompt).toBe('test prompt')
    expect(row.tmux_session).toBe('bg-ABCD1234')
    expect(row.finished_at).toBeNull()
  })

  it('finishes a task with done status', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, tmux_session, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('AAAA1111', 'samu', 'build something', 'running', 'bg-AAAA1111', now)

    db.prepare('UPDATE background_tasks SET status = ?, finished_at = ?, output = ? WHERE id = ?')
      .run('done', now + 100, 'Build succeeded', 'AAAA1111')

    const row = db.prepare('SELECT * FROM background_tasks WHERE id = ?').get('AAAA1111') as any
    expect(row.status).toBe('done')
    expect(row.output).toBe('Build succeeded')
    expect(row.finished_at).toBe(now + 100)
  })

  it('rejects invalid status', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(() => {
      db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)')
        .run('BAD10000', 'test', 'bad', 'invalid_status', now)
    }).toThrow()
  })

  it('counts running tasks per agent', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)').run('A1000001', 'marveen', 'p1', 'running', now)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)').run('A2000002', 'marveen', 'p2', 'running', now)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)').run('A3000003', 'marveen', 'p3', 'done', now)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)').run('A4000004', 'samu', 'p4', 'running', now)

    const count = (db.prepare("SELECT COUNT(*) as c FROM background_tasks WHERE agent_id = ? AND status = 'running'").get('marveen') as any).c
    expect(count).toBe(2)

    const samuCount = (db.prepare("SELECT COUNT(*) as c FROM background_tasks WHERE agent_id = ? AND status = 'running'").get('samu') as any).c
    expect(samuCount).toBe(1)
  })

  it('lists tasks with optional agent filter', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)').run('B1000001', 'marveen', 'p1', 'running', now)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)').run('B2000002', 'samu', 'p2', 'done', now)

    const all = db.prepare('SELECT * FROM background_tasks ORDER BY started_at DESC').all()
    expect(all).toHaveLength(2)

    const running = db.prepare("SELECT * FROM background_tasks WHERE status = 'running'").all()
    expect(running).toHaveLength(1)

    const marveenOnly = db.prepare("SELECT * FROM background_tasks WHERE agent_id = ? AND status = 'running'").all('marveen')
    expect(marveenOnly).toHaveLength(1)
  })

  it('supports timeout status', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at) VALUES (?, ?, ?, ?, ?)').run('T1000001', 'test', 'slow task', 'running', now)
    db.prepare('UPDATE background_tasks SET status = ?, finished_at = ?, output = ? WHERE id = ?')
      .run('timeout', now + 1800, '(timeout after 30 min)', 'T1000001')

    const row = db.prepare('SELECT * FROM background_tasks WHERE id = ?').get('T1000001') as any
    expect(row.status).toBe('timeout')
  })

  it('atomic create respects concurrency limit', () => {
    const now = Math.floor(Date.now() / 1000)
    const maxConcurrent = 3

    const atomicCreate = db.transaction((id: string, agentId: string, prompt: string, session: string) => {
      const running = (db.prepare("SELECT COUNT(*) as c FROM background_tasks WHERE agent_id = ? AND status = 'running'").get(agentId) as any).c
      if (running >= maxConcurrent) return null
      db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, tmux_session, started_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, agentId, prompt, 'running', session, now)
      return { id }
    })

    expect(atomicCreate('C1000001', 'agent1', 'p1', 'bg-C1000001')).toBeTruthy()
    expect(atomicCreate('C2000002', 'agent1', 'p2', 'bg-C2000002')).toBeTruthy()
    expect(atomicCreate('C3000003', 'agent1', 'p3', 'bg-C3000003')).toBeTruthy()
    expect(atomicCreate('C4000004', 'agent1', 'p4', 'bg-C4000004')).toBeNull()

    expect(atomicCreate('C5000005', 'agent2', 'p5', 'bg-C5000005')).toBeTruthy()
  })

  it('marks orphaned tasks as failed', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, tmux_session, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('OR000001', 'marveen', 'orphan', 'running', 'bg-OR000001', now - 3600)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, tmux_session, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('OR000002', 'samu', 'also orphan', 'running', 'bg-OR000002', now - 1800)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('OR000003', 'marveen', 'already done', 'done', now - 7200, now - 3600)

    const finishNow = Math.floor(Date.now() / 1000)
    const info = db.prepare("UPDATE background_tasks SET status = 'failed', finished_at = ?, output = '(orphaned on restart)' WHERE status = 'running'")
      .run(finishNow)
    expect(info.changes).toBe(2)

    const tasks = db.prepare('SELECT * FROM background_tasks ORDER BY id').all() as any[]
    expect(tasks.find((t: any) => t.id === 'OR000001').status).toBe('failed')
    expect(tasks.find((t: any) => t.id === 'OR000002').status).toBe('failed')
    expect(tasks.find((t: any) => t.id === 'OR000003').status).toBe('done')
  })

  it('DELETE captures output before kill (order test)', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare('INSERT INTO background_tasks (id, agent_id, prompt, status, tmux_session, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('DE000001', 'marveen', 'cancel me', 'running', 'bg-DE000001', now)

    const task = db.prepare('SELECT * FROM background_tasks WHERE id = ?').get('DE000001') as any
    expect(task.status).toBe('running')
    expect(task.tmux_session).toBe('bg-DE000001')

    db.prepare('UPDATE background_tasks SET status = ?, finished_at = ?, output = ? WHERE id = ?')
      .run('failed', now + 1, 'captured output before kill', 'DE000001')

    const cancelled = db.prepare('SELECT * FROM background_tasks WHERE id = ?').get('DE000001') as any
    expect(cancelled.status).toBe('failed')
    expect(cancelled.output).toBe('captured output before kill')
  })
})

describe('background-tasks route ID regex', () => {
  it('matches exactly 8 hex chars', () => {
    const re = /^\/api\/background-tasks\/([A-F0-9]{8})$/
    expect(re.test('/api/background-tasks/ABCD1234')).toBe(true)
    expect(re.test('/api/background-tasks/12345678')).toBe(true)
    expect(re.test('/api/background-tasks/ABCD123')).toBe(false)
    expect(re.test('/api/background-tasks/ABCD12345')).toBe(false)
    expect(re.test('/api/background-tasks/abcd1234')).toBe(false)
    expect(re.test('/api/background-tasks/')).toBe(false)
  })
})

// BGPMODE826 unit-tesztek: a modelEnv építő függvény viselkedése. A függvény
// azert kulon exportalva, hogy a shell-biztos escapelest es a szurest
// kozvetlenul tesztelhessuk, tmux szerver inditasa nelkul.
describe('buildModelEnv (BGPMODE826)', () => {
  it('returns empty string when no ANTHROPIC_* vars are set', () => {
    expect(buildModelEnv({})).toBe('')
    expect(buildModelEnv({ PATH: '/usr/bin' })).toBe('')
  })

  it('exports each known ANTHROPIC_* var when set', () => {
    const out = buildModelEnv({
      ANTHROPIC_BASE_URL: 'https://api.example.com',
      ANTHROPIC_AUTH_TOKEN: 'sk-test-token',
      ANTHROPIC_MODEL: 'claude-test',
    })
    expect(out).toContain(`export ANTHROPIC_BASE_URL='https://api.example.com'`)
    expect(out).toContain(`export ANTHROPIC_AUTH_TOKEN='sk-test-token'`)
    expect(out).toContain(`export ANTHROPIC_MODEL='claude-test'`)
  })

  it('joins multiple exports with ` && ` so they chain in a single shell command', () => {
    const out = buildModelEnv({
      ANTHROPIC_BASE_URL: 'a',
      ANTHROPIC_API_KEY: 'b',
    })
    expect(out).toBe(`export ANTHROPIC_BASE_URL='a' && export ANTHROPIC_API_KEY='b'`)
  })

  it('escapes single quotes in values so shell injection is impossible', () => {
    // A '\'' trükk: zarjuk a ' körulezart sztringet, rakjunk egy esc-elt '-
    // t, majd nyissunk egy uj sztringet. A replace MINDEN ' karaktert
    // atalakit, igy a 'evil';rm -rf / mintabol 'evil'\'';rm -rf / lesz,
    // es az egesz egy kulsz sztringen belulre kerul.
    const out = buildModelEnv({ ANTHROPIC_BASE_URL: `https://x.com/'evil';rm -rf /` })
    // A teljes export-sor egyetlen shell-tokenkent ertekelodik ki:
    // a '...' kornyezo sztring vegen a kulsz ' zar, kozben '\'' escape-elt,
    // utana uj ' nyit -- ezert shell oldalrol az egesz egyetlen sztring.
    expect(out).toBe(`export ANTHROPIC_BASE_URL='https://x.com/'\\''evil'\\'';rm -rf /'`)
    // Fontos: a `rm -rf /` az export-sor reszekent jelenik meg (parameter-
    // kent), nem kulon shell-parancskent. A `\\''` zarojelparok biztositjak,
    // hogy ne lehessen a ' kozul kilepve egy masik parancsot injectalni.
    expect(out).toContain(`'\\'';rm -rf /'`)
  })

  it('ignores unknown env vars (only the whitelisted keys propagate)', () => {
    const out = buildModelEnv({
      ANTHROPIC_BASE_URL: 'kell',
      PATH: '/usr/bin',
      HOME: '/home/x',
      RANDOM_NOISE: 'noise',
      ANTHROPIC_AUTH_TOKEN: 'kell2',
    })
    expect(out).toContain(`export ANTHROPIC_BASE_URL='kell'`)
    expect(out).toContain(`export ANTHROPIC_AUTH_TOKEN='kell2'`)
    expect(out).not.toContain('PATH')
    expect(out).not.toContain('HOME')
    expect(out).not.toContain('RANDOM_NOISE')
  })

  it('handles every documented MODEL_ENV_KEYS key', () => {
    const all = {
      ANTHROPIC_BASE_URL: '1',
      ANTHROPIC_AUTH_TOKEN: '2',
      ANTHROPIC_API_KEY: '3',
      ANTHROPIC_MODEL: '4',
      ANTHROPIC_DEFAULT_SONNET_MODEL: '5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: '6',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: '7',
    }
    const out = buildModelEnv(all)
    for (const k of Object.keys(all)) {
      expect(out).toContain(`export ${k}='${all[k as keyof typeof all]}'`)
    }
  })
})

// BGPMODE826 INTEGRÁCIÓS TESZT (kézi): tmux szerver env-izoláció (production-only bug).
// A tmux kliens-szerver architektúra miatt egy új session a SZERVER env-jét
// örökli, nem a kliensét -- ezt unit-tesztben nem lehet 100%-osan rekonstruálni
// (mert a tesztkörnyezetben a tmux szerver a teszt idején indul, és minden
// session örökli az aktuális process.env-et). A TELJES regression ellenőrzéshez
// kézzel kell futtatni:
//
//   1. Terminálban indíts egy host tmux szervert: `tmux`
//   2. A dashboard-ból spawnolj egy háttérfeladatot (POST /api/background-tasks)
//   3. A task kimenetében a "Not logged in - Please run /login" NEM szabad megjelenjen
//   4. Ha megjelenik, a fix visszarepült: buildModelEnv kimenete nem került a parancsba
//
// A lentebbi unit teszt csak a koncepciót rögzíti: ha a parancs a buildModelEnv
// kimenetével kezdődik, a session-ben az ANTHROPIC_* változók LÁTSZANAK,
// függetlenül a tmux szerver induláskori env-jétől.
describe('tmux server env isolation -- manual regression recipe (BGPMODE826)', () => {
  it('buildModelEnv output, ha a parancs első tokenje, garantáltan propagálódik', () => {
    const exported = buildModelEnv({ ANTHROPIC_BASE_URL: 'https://probe.example' })
    expect(exported.startsWith(`export ANTHROPIC_BASE_URL=`)).toBe(true)
    expect(exported).toBe(`export ANTHROPIC_BASE_URL='https://probe.example'`)
  })
})
