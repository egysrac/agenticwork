import { randomBytes } from 'node:crypto'
import { execSync, execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createBackgroundTaskAtomic, finishBackgroundTask, getBackgroundTasks,
  getBackgroundTask, getRunningBackgroundTasks, markOrphanedTasksFailed,
  type BackgroundTask,
} from '../../db.js'
import { resolveFromPath } from '../../platform.js'
import { APP_TZ } from '../../config.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const TMUX = resolveFromPath('tmux')
const CLAUDE = resolveFromPath('claude')
const MAX_CONCURRENT = 3
const TIMEOUT_MS = 30 * 60 * 1000

const TZ = APP_TZ  // install zone (config.APP_TZ); was hardcoded Europe/Budapest

function bgSessionName(id: string): string {
  return `bg-${id}`
}

// MODEL_ENV_KEYS: azok a kornyezeti valtozok, amiket a tmux session-ben futo
// `claude -p` feltetlenul latnia kell. A tmux SZERVER env-jet orokli (ami a
// szerver indulaskor rogzult), nem a klienset -- ezert ezeket a parancsban
// explicit exportaljuk. (BGPMODE826)
const MODEL_ENV_KEYS = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
]

// buildModelEnv: a process.env-bol kinyeri a MODEL_ENV_KEYS-ben felsorolt
// valtozokat, es egy `export K='V' && export K2='V2' && ...` lancot epit
// beloluk (shell-biztos escape-pel). Ha nincs egyetlen sem, ures stringet ad.
// EXPORTALT, hogy a tesztek kozvetlenul tudjak vizsgalni a kimenetet.
export function buildModelEnv(env: NodeJS.ProcessEnv = process.env): string {
  return MODEL_ENV_KEYS
    .filter((k) => env[k])
    .map((k) => `export ${k}='${String(env[k]).replace(/'/g, "'\\''")}'`)
    .join(' && ')
}

function isBgSessionAlive(session: string): boolean {
  try {
    const out = execFileSync(TMUX, ['list-sessions', '-F', '#{session_name}'], { timeout: 3000, encoding: 'utf-8' })
    return out.split('\n').some(l => l.trim() === session)
  } catch {
    return false
  }
}

function captureSession(session: string): string | null {
  try {
    return execFileSync(TMUX, ['capture-pane', '-t', session, '-p', '-S', '-500'], { timeout: 5000, encoding: 'utf-8' })
  } catch {
    return null
  }
}

function killSession(session: string): void {
  try {
    execFileSync(TMUX, ['kill-session', '-t', session], { timeout: 3000 })
  } catch { /* already dead */ }
}

// FÁJL-ALAPÚ OUTPUT (2026-08-26): a kimenet es a `___BG_DONE___` marker a
// `bg-output-${id}.txt` fajlba irodik (a tmux pane helyett). A poller innen
// olvas, NEM a captureSession-bol -- igy a session lifecycle es az output
// capture SZET VAN VALASZTVA. A korabbi 5s/60s sleep ablak azert kellett,
// mert a captureSession csak elo sessionbol tudott olvasni, es ha a session
// idokozben meghalt, a marker elveszett. Fajl eseten nincs ilyen race: a fajl
// megmarad a session halal utan is, a poller es a startup sweep is olvashatja.
function readOutputFile(id: string): string | null {
  const file = join(tmpdir(), `bg-output-${id}.txt`)
  if (!existsSync(file)) return null
  try {
    return readFileSync(file, 'utf-8')
  } catch {
    return null
  }
}

export function spawnBackgroundTask(agentId: string, prompt: string): BackgroundTask | { error: string } {
  const id = randomBytes(4).toString('hex').toUpperCase()
  const session = bgSessionName(id)

  const task = createBackgroundTaskAtomic(id, agentId, prompt, session, MAX_CONCURRENT)
  if (!task) {
    return { error: `Maximum ${MAX_CONCURRENT} egyidejű háttérfeladat ágensenként.` }
  }

  // A promptot FAJLON at adjuk at, nem kornyezeti valtozoban. A `tmux new-session`
  // a mar futo tmux SZERVERrel hozza letre a sessiont, ami a hivo env-jet (es igy a
  // BG_PROMPT-ot) NEM orokli -> a "$BG_PROMPT" uresre oldodott, es minden
  // hattermunka azonnal elhasalt ezzel: "Input must be provided either through
  // stdin or as a prompt argument". (2026-08-21)
  const promptFile = join(tmpdir(), `bg-prompt-${id}.txt`)
  const outputFile = join(tmpdir(), `bg-output-${id}.txt`)
  writeFileSync(promptFile, prompt, { mode: 0o600 })
  const modelEnv = buildModelEnv()
  const shellCmd = [
    `export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"`,
    ...(modelEnv ? [modelEnv] : []),
    // --dangerously-skip-permissions: `-p` modban senki nem tud jovahagyni egy
    // permission promptot, igy nelkule minden erdemi hattermunka elakad. A
    // flotta minden mas sessionje (fo agens, workerek, sub-agensek) is igy fut.
    // Fajl-alapu output: a stdout+stderr a `bg-output-${id}.txt`-be megy, es a
    // marker is oda irodik (a tmux pane helyett). Igy a poller a session
    // lifecycle-jatol fuggetlenul tudja olvasni a vegeredmenyt.
    `{ cat ${promptFile} | ${CLAUDE} -p --dangerously-skip-permissions --output-format text; echo '___BG_DONE___'; } > ${outputFile} 2>&1`,
    `rm -f ${promptFile}`,
    // A 30s sleep azert kell, hogy a tmux session meg elo legyen egy darabig
    // a feladat vege utan -- ezalatt a live output capture meg elmegy a
    // dashboardon (captureSession). Nem race-kritikus: a fajl akkor is ott
    // van, ha a session idokozben meghal.
    `sleep 30`,
  ].join('; ')

  try {
    execFileSync(TMUX, [
      'new-session', '-d', '-s', session, '-x', '200', '-y', '50',
      `${shellCmd}`,
    ], {
      timeout: 5000,
      env: { ...process.env, BG_PROMPT: prompt },
    })
  } catch (err) {
    logger.error({ err, id, session }, 'Failed to spawn background task tmux session')
    finishBackgroundTask(id, 'failed', '(spawn failed)')
    return { error: 'Nem sikerült elindítani a háttérfeladatot' }
  }

  logger.info({ id, agentId, session, prompt: prompt.slice(0, 100) }, 'Background task started')

  setTimeout(() => checkAndFinalize(id), TIMEOUT_MS)
  pollUntilDone(id)

  return task
}

function pollUntilDone(id: string): void {
  const interval = setInterval(() => {
    const task = getBackgroundTask(id)
    if (!task || task.status !== 'running') {
      clearInterval(interval)
      return
    }

    // Fajl-alapu olvasas: ha a marker megvan a fajlban, a feladat vegezte --
    // fuggetlenul attol, hogy a tmux session meg elo-e vagy mar meghalt.
    // (2026-08-26, BGPMODE826 refaktor)
    const fileOut = readOutputFile(id)
    if (fileOut !== null && fileOut.includes('___BG_DONE___')) {
      const output = fileOut.replace(/___BG_DONE___[\s\S]*$/, '').trim()
      finishBackgroundTask(id, 'done', output)
      if (task.tmux_session) killSession(task.tmux_session)
      logger.info({ id }, 'Background task completed')
      clearInterval(interval)
    }
  }, 10_000)
}

function checkAndFinalize(id: string): void {
  const task = getBackgroundTask(id)
  if (!task || task.status !== 'running') return

  // Timeout-nal is a fajlbol olvasunk -- igy ha a 30 perc alatt vegzett a
  // task, de a poller valamiert lemaradt, meg megvan a tenyleges kimenet.
  const fileOut = readOutputFile(id)
  const session = task.tmux_session
  if (fileOut !== null && fileOut.includes('___BG_DONE___')) {
    const clean = fileOut.replace(/___BG_DONE___[\s\S]*$/, '').trim()
    finishBackgroundTask(id, 'done', clean)
    if (session) killSession(session)
    logger.warn({ id }, 'Background task already done before 30min timeout (poller missed it)')
    return
  }
  const tmuxOut = session ? captureSession(session) : null
  finishBackgroundTask(id, 'timeout', tmuxOut?.trim() || fileOut?.trim() || '(timeout)')
  if (session) killSession(session)
  logger.warn({ id }, 'Background task timed out after 30 minutes')
}

export function sweepOrphanedBackgroundTasks(): void {
  const running = getRunningBackgroundTasks()
  let orphaned = 0
  for (const task of running) {
    if (!task.tmux_session || !isBgSessionAlive(task.tmux_session)) {
      // Ha a session meghalt, megnezzuk a fajlt -- ha abban megvan a marker,
      // a feladat valojaban kesz volt, csak a poller maradt le. (BGPMODE826)
      const fileOut = readOutputFile(task.id)
      if (fileOut !== null && fileOut.includes('___BG_DONE___')) {
        const clean = fileOut.replace(/___BG_DONE___[\s\S]*$/, '').trim()
        finishBackgroundTask(task.id, 'done', clean)
        logger.info({ id: task.id }, 'Recovered completed background task from output file on sweep')
      } else {
        const tmuxOut = task.tmux_session ? captureSession(task.tmux_session) : null
        finishBackgroundTask(task.id, 'failed', tmuxOut?.trim() || fileOut?.trim() || '(orphaned on restart)')
        orphaned++
      }
    } else {
      setTimeout(() => checkAndFinalize(task.id), TIMEOUT_MS)
      pollUntilDone(task.id)
    }
  }
  if (orphaned) logger.info({ orphaned }, 'Swept orphaned background tasks on startup')
}

const TASK_ID_RE = /^\/api\/background-tasks\/([A-F0-9]{8})$/

export async function tryHandleBackgroundTasks(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/background-tasks' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { agent_id: string; prompt: string }
    if (!data.prompt?.trim()) {
      json(res, { error: 'Prompt megadása kötelező' }, 400)
      return true
    }
    if (!data.agent_id?.trim()) {
      json(res, { error: 'Agent ID megadása kötelező' }, 400)
      return true
    }

    const result = spawnBackgroundTask(data.agent_id.trim(), data.prompt.trim())
    if ('error' in result) {
      json(res, { error: result.error }, 429)
      return true
    }
    json(res, result, 201)
    return true
  }

  if (path === '/api/background-tasks' && method === 'GET') {
    const agentId = url.searchParams.get('agent') || undefined
    const all = url.searchParams.get('all') === 'true'
    const tasks = getBackgroundTasks(agentId, all)
    const formatted = tasks.map(t => ({
      ...t,
      started_label: new Date(t.started_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }),
      finished_label: t.finished_at ? new Date(t.finished_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }) : null,
    }))
    json(res, formatted)
    return true
  }

  const taskMatch = path.match(TASK_ID_RE)
  if (taskMatch && method === 'GET') {
    const task = getBackgroundTask(taskMatch[1])
    if (!task) { json(res, { error: 'Háttérfeladat nem található' }, 404); return true }

    let liveOutput: string | null = null
    if (task.status === 'running' && task.tmux_session) {
      // captureSession az elsodleges (friss, sorrol-sorra frissul a tmux
      // pane-bol); a fajl a fallback, ha a session mar meghalt. (BGPMODE826)
      liveOutput = captureSession(task.tmux_session) || readOutputFile(task.id)
    }

    json(res, {
      ...task,
      liveOutput,
      started_label: new Date(task.started_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }),
      finished_label: task.finished_at ? new Date(task.finished_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }) : null,
    })
    return true
  }

  if (taskMatch && method === 'DELETE') {
    const task = getBackgroundTask(taskMatch[1])
    if (!task) { json(res, { error: 'Háttérfeladat nem található' }, 404); return true }
    // Fajl-elsobbség a cancelnel: ha a task idokozben befejezodott es a
    // marker megvan a fajlban, ne veszitsuk el a kimenetet egy cancel miatt.
    // (BGPMODE826)
    const fileOut = readOutputFile(task.id)
    const tmuxOut = task.tmux_session ? captureSession(task.tmux_session) : null
    if (task.status === 'running' && task.tmux_session) {
      killSession(task.tmux_session)
    }
    if (fileOut !== null && fileOut.includes('___BG_DONE___')) {
      const clean = fileOut.replace(/___BG_DONE___[\s\S]*$/, '').trim()
      finishBackgroundTask(task.id, 'done', clean)
    } else {
      const output = tmuxOut?.trim() || fileOut?.trim() || '(cancelled)'
      finishBackgroundTask(task.id, 'failed', output)
    }
    json(res, { ok: true })
    return true
  }

  return false
}
