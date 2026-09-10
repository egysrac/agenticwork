import { recallByDateRange, recallSearch, getDailyLogDates, getDb } from '../../db.js'
import { MAIN_AGENT_ID, APP_TZ, CONTEXT_GATE_CANARY_ENABLED } from '../../config.js'
import { json } from '../http-helpers.js'
import { gateContext, assembleContext } from '../../context-gate.js'
import type { RelevanceChunk } from '../../qwen-router.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'
import { contextGateCanaryRouteDecision, runContextGateCanary } from '../../context-gate-canary.js'
import { appendTaskObservation } from '../../task-observability.js'

const TZ = APP_TZ  // install zone (config.APP_TZ); was hardcoded Europe/Budapest

function todayBudapest(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date())
}

function budapestDate(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(d)
}

function addDays(dateStr: string, days: number): string {
  const ms = new Date(`${dateStr}T12:00:00Z`).getTime() + days * 86_400_000
  return budapestDate(new Date(ms))
}

function dayOfWeekBudapest(dateStr: string): number {
  const d = new Date(`${dateStr}T12:00:00Z`)
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d)
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return map[weekday] ?? 0
}

function startOfWeek(dateStr: string): string {
  const dow = dayOfWeekBudapest(dateStr)
  const diff = dow === 0 ? -6 : 1 - dow
  return addDays(dateStr, diff)
}

function startOfMonth(dateStr: string): string {
  return dateStr.slice(0, 8) + '01'
}

function endOfMonth(dateStr: string): string {
  const [y, m] = dateStr.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0))
  return budapestDate(last)
}

const HU_MONTHS: Record<string, string> = {
  'januar': '01', 'februar': '02', 'marcius': '03', 'aprilis': '04',
  'majus': '05', 'junius': '06', 'julius': '07', 'augusztus': '08',
  'szeptember': '09', 'oktober': '10', 'november': '11', 'december': '12',
  'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04',
  'maj': '05', 'jun': '06', 'jul': '07', 'aug': '08',
  'szept': '09', 'okt': '10', 'nov': '11', 'dec': '12',
}

const HU_DAYS: Record<string, number> = {
  'hetfo': 1, 'kedd': 2, 'szerda': 3, 'csutortok': 4,
  'pentek': 5, 'szombat': 6, 'vasarnap': 0,
}

interface DateRange { from: string; to: string }

function stripAccents(s: string): string {
  return s
    .replace(/á/g, 'a').replace(/é/g, 'e').replace(/í/g, 'i')
    .replace(/ó/g, 'o').replace(/ö/g, 'o').replace(/ő/g, 'o')
    .replace(/ú/g, 'u').replace(/ü/g, 'u').replace(/ű/g, 'u')
}

function lastOccurrence(targetDow: number, today: string): string {
  const todayDow = dayOfWeekBudapest(today)
  let diff = todayDow - targetDow
  if (diff <= 0) diff += 7
  return addDays(today, -diff)
}

export function parseDateExpression(input: string): DateRange | null {
  const raw = input.trim()
  const s = stripAccents(raw.toLowerCase())
  const today = todayBudapest()

  if (/^(\d{4})-(\d{2})-(\d{2})$/.test(raw)) {
    return { from: raw, to: raw }
  }

  const rangeMatch = raw.match(/^(\d{4}-\d{2}-\d{2})\s*[-–]\s*(\d{4}-\d{2}-\d{2})$/)
  if (rangeMatch) {
    return { from: rangeMatch[1], to: rangeMatch[2] }
  }

  if (s === 'ma' || s === 'today') return { from: today, to: today }
  if (s === 'tegnap' || s === 'yesterday') {
    const d = addDays(today, -1)
    return { from: d, to: d }
  }
  if (s === 'tegnapelott') {
    const d = addDays(today, -2)
    return { from: d, to: d }
  }

  for (const [name, dow] of Object.entries(HU_DAYS)) {
    if (s === name || s === `mult ${name}` || s === `elozo ${name}`) {
      const d = lastOccurrence(dow, today)
      return { from: d, to: d }
    }
  }

  const daysAgoMatch = s.match(/^(\d+)\s*nap(?:ja|pal?\s+ezelott)?$/)
  if (daysAgoMatch) {
    const d = addDays(today, -parseInt(daysAgoMatch[1], 10))
    return { from: d, to: d }
  }

  const weeksAgoMatch = s.match(/^(\d+)\s*het(?:e|tel?\s+ezelott)?$/)
  if (weeksAgoMatch) {
    const daysBack = parseInt(weeksAgoMatch[1], 10) * 7
    const from = addDays(today, -daysBack)
    const to = addDays(from, 6)
    return { from, to: to > today ? today : to }
  }

  if (s === 'ezen a heten' || s === 'ez a het' || s === 'this week') {
    return { from: startOfWeek(today), to: today }
  }
  if (s === 'mult heten' || s === 'elozo het' || s === 'last week') {
    const lastWeekDay = addDays(today, -7)
    const from = startOfWeek(lastWeekDay)
    return { from, to: addDays(from, 6) }
  }

  if (s === 'ebben a honapban' || s === 'ez a honap' || s === 'this month') {
    return { from: startOfMonth(today), to: today }
  }
  if (s === 'mult honapban' || s === 'elozo honap' || s === 'last month') {
    const prevMonth = addDays(startOfMonth(today), -1)
    return { from: startOfMonth(prevMonth), to: prevMonth }
  }

  const lastNDaysMatch = s.match(/^(?:utolso|elmult)\s+(\d+)\s*nap$/)
  if (lastNDaysMatch) {
    return { from: addDays(today, -parseInt(lastNDaysMatch[1], 10)), to: today }
  }

  for (const [name, num] of Object.entries(HU_MONTHS)) {
    const weekMatch = s.match(new RegExp(`${name}\\s+(elso|masodik|harmadik|negyedik|utolso)\\s+het`))
    if (weekMatch) {
      const year = today.slice(0, 4)
      const monthStart = `${year}-${num}-01`
      const monthEnd = endOfMonth(monthStart)
      const weekMap: Record<string, number> = { elso: 0, masodik: 1, harmadik: 2, negyedik: 3 }
      if (weekMatch[1] === 'utolso') {
        const to = monthEnd
        const from = addDays(to, -6)
        return { from, to }
      }
      const weekIdx = weekMap[weekMatch[1]] ?? 0
      let weekStart = startOfWeek(monthStart)
      if (weekStart < monthStart) weekStart = addDays(weekStart, 7)
      const from = addDays(weekStart, weekIdx * 7)
      const to = addDays(from, 6)
      return { from, to: to > monthEnd ? monthEnd : to }
    }

    const dayMatch = s.match(new RegExp(`${name}\\s+(\\d{1,2})`))
    if (dayMatch) {
      const year = today.slice(0, 4)
      const day = dayMatch[1].padStart(2, '0')
      const d = `${year}-${num}-${day}`
      return { from: d, to: d }
    }

    if (s === name || s === `${name}ban` || s === `${name}ben`) {
      const year = today.slice(0, 4)
      const monthStart = `${year}-${num}-01`
      return { from: monthStart, to: endOfMonth(monthStart) }
    }
  }

  return null
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

export async function tryHandleRecall(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx
  // Caller headers are assertions, not authenticated provenance. Keep recall
  // observations server-generated and deliberately non-correlatable.
  const observation = { correlationId: undefined, sessionId: null, taskId: null }

  const canaryDecision = contextGateCanaryRouteDecision(path, method, CONTEXT_GATE_CANARY_ENABLED)
  if (canaryDecision !== 'not_canary') {
    if (canaryDecision === 'disabled') {
      json(res, { error: 'context_gate_canary_disabled' }, 404)
      return true
    }
    json(res, await runContextGateCanary(undefined, { db: getDb(), correlationId: observation.correlationId, sessionId: observation.sessionId }))
    return true
  }

  if (path === '/api/recall' && method === 'GET') {
    const dateExpr = url.searchParams.get('date') || ''
    const query = url.searchParams.get('q') || ''
    const agent = url.searchParams.get('agent') || undefined
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)
    // Context Gate (Phase 3): opt-in via ?gate=true. When enabled, the
    // returned memories are filtered through gateContext() (deterministic
    // pre-filter + qwen2.5:3b relevance filter) down to `gateTopK` most
    // relevant. Default OFF so existing callers see no behavioral change.
    const gate = url.searchParams.get('gate') === 'true'
    const gateTopK = Math.min(Math.max(parseInt(url.searchParams.get('gateTopK') || '5', 10), 1), 20)

    if (query && !dateExpr) {
      const result = recallSearch(query, agent, limit)
      const formatted = await maybeGateMemories(result, query, { enabled: gate, topK: gateTopK }, observation)
      json(res, formatted)
      return true
    }

    const range = dateExpr ? parseDateExpression(dateExpr) : { from: todayBudapest(), to: todayBudapest() }
    if (!range) {
      json(res, { error: `Nem értelmezhető dátum: "${dateExpr}"` }, 400)
      return true
    }

    const result = recallByDateRange(range.from, range.to, agent)

    if (query) {
      const escaped = escapeLike(query)
      const qLower = escaped.toLowerCase()
      result.logs = result.logs.filter(l => l.content.toLowerCase().includes(qLower))
      result.memories = result.memories.filter(m => m.content.toLowerCase().includes(qLower) || (m.keywords || '').toLowerCase().includes(qLower))
    }

    const formatted = await maybeGateMemories(result, query, { enabled: gate, topK: gateTopK }, observation)
    json(res, formatted)
    return true
  }

  if (path === '/api/recall/dates' && method === 'GET') {
    const agent = url.searchParams.get('agent') || MAIN_AGENT_ID
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '90', 10), 365)
    json(res, getDailyLogDates(agent, limit))
    return true
  }

  return false
}

function formatRecallResult(result: { logs: any[]; memories: any[]; dateRange: { from: string; to: string } }, gateMeta?: { enabled: boolean; before: number; after: number; topK: number }) {
  return {
    dateRange: result.dateRange,
    logs: result.logs.map(l => ({
      ...l,
      created_label: new Date(l.created_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }),
    })),
    memories: result.memories.map(m => ({
      ...m,
      embedding: undefined,
      created_label: new Date(m.created_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }),
    })),
    summary: {
      logCount: result.logs.length,
      memoryCount: result.memories.length,
      agents: [...new Set([...result.logs.map(l => l.agent_id), ...result.memories.map(m => m.agent_id)])],
    },
    gate: gateMeta ?? null,
  }
}

// Context Gate wrapper for the recall endpoint (Phase 3 / TASK-0016).
// - When gate.enabled is false, returns the result unchanged.
// - When the result has few memories (<= topK), returns unchanged (no benefit).
// - When the gate errors or returns empty, returns the original list (degraded
//   mode) so callers still get something -- the gate is a filter, not a gate.
// - Adds a `gate: { enabled, before, after, topK }` field to the response so
//   callers can see what was filtered.
async function maybeGateMemories(
  result: { logs: any[]; memories: any[]; dateRange: { from: string; to: string } },
  query: string,
  opts: { enabled: boolean; topK: number },
  observation?: { correlationId?: string; sessionId: string | null; taskId: string | null },
): Promise<ReturnType<typeof formatRecallResult>> {
  if (!opts.enabled) return formatRecallResult(result)
  const observe = (outcome: string, before: number, after: number, returnedUnfiltered: boolean) => {
    if (!observation) return
    try {
      appendTaskObservation(getDb(), {
        correlationId: observation.correlationId, kind: 'context_gate_measurement',
        taskId: observation.taskId, sessionId: observation.sessionId,
        provenance: 'TASK-0016.recall.context_gate.v1',
        metadata: { source: 'recall', outcome, candidate_count: before,
          returned_count: after, top_k: opts.topK, returned_unfiltered: returnedUnfiltered,
          query_present: Boolean(query.trim()), gate_enabled: true },
      })
    } catch (err) {
      logger.warn({ err }, 'recall: observation persistence failed')
    }
  }
  if (!query.trim()) {
    observe('skipped_no_query', result.memories.length, result.memories.length, true)
    return formatRecallResult(result)
  }
  const before = result.memories.length
  if (before <= opts.topK) {
    observe('skipped_bounded_input', before, before, true)
    return formatRecallResult(result, { enabled: true, before, after: before, topK: opts.topK })
  }

  const candidates: RelevanceChunk[] = result.memories.map(m => ({
    id: String(m.id),
    content: m.content,
  }))

  let gateResult
  try {
    gateResult = await gateContext(query, candidates, {
      topK: opts.topK,
      cost: 'low',
      deterministicMax: 20,
    })
  } catch (err) {
    logger.warn({ err, query: query.slice(0, 80) }, 'recall: context gate failed, returning unfiltered memories')
    observe('fail_open_error', before, before, true)
    return formatRecallResult(result, { enabled: true, before, after: before, topK: opts.topK })
  }

  if (gateResult.length === 0) {
    observe('fail_open_empty', before, before, true)
    return formatRecallResult(result, { enabled: true, before, after: before, topK: opts.topK })
  }

  const idsKept = new Set(gateResult.map(r => r.id))
  const filteredMemories = result.memories.filter(m => idsKept.has(String(m.id)))
  const after = filteredMemories.length

  observe('filtered', before, after, false)

  logger.info(
    { query: query.slice(0, 80), before, after, topK: opts.topK },
    'recall: context gate filtered memories',
  )

  // expose the assembled top-K context as a convenience for callers that
  // want a single string instead of the structured memories
  const assembled = assembleContext(gateResult, candidates) ?? undefined

  const formatted = formatRecallResult(
    { ...result, memories: filteredMemories },
    { enabled: true, before, after, topK: opts.topK },
  )
  if (assembled) (formatted as any).assembledContext = assembled
  return formatted
}
