// context-gate.ts -- the Context Gate pipeline (Phase 3 / TASK-0015).
//
// Sits between a candidate-set producer (memory search, vector retrieval,
// file grep, etc.) and a cloud call. Decides which candidates actually
// belong in the cloud's context window.
//
// Pipeline:
//
//   query + candidates (RelevanceChunk[])
//     │
//     ▼
//   1. deterministic pre-filter (keyword match, fast & free)
//     │  -- if candidates <= deterministicMax, skipped
//     │  -- always preserves order; never drops below hardFloor
//     ▼
//   2. relevanceFilter() (qwen2.5:3b on the LAN Ollama, batch + fallback)
//     │  -- topK most relevant chunks
//     ▼
//   3. assemble() -- join top-K contents into a single context string
//
// Design notes:
//   - The gate is intentionally a thin wrapper around relevanceFilter().
//     Future layers (token budget enforcement, cross-encoder rerank, etc.)
//     slot in between (2) and (3) without changing the public API.
//   - NEVER throws. On total failure the gate returns the candidates as-is
//     in the "no pre-filter" degraded mode -- the caller still gets SOMETHING
//     rather than an exception that would abort the surrounding cloud call.
//   - The relevance filter uses cost:'low' by default (Qwen first, Anthropic
//     fallback) so the gate is free on the happy path.

import { relevanceFilter, type RelevanceChunk, type RelevanceResult, type RelevanceFilterOptions } from './qwen-router.js'
import { logger } from './logger.js'

/** Options for `gateContext`. */
export interface GateContextOptions extends RelevanceFilterOptions {
  /**
   * Skip the Qwen relevance filter when the candidate count is at or below
   * this number. Rationale: a 5-candidate set does not benefit from a model
   * call that costs ~5 seconds; just keep them in deterministic order.
   * Defaults to 20.
   */
  deterministicMax?: number

  /**
   * Even when the pre-filter or relevance filter would drop chunks, always
   * keep at least this many of the top-recall candidates. Protects against
   * pathological "0 results" outcomes when the model over-prunes. Defaults to 1.
   */
  hardFloor?: number
}

const DEFAULT_DETERMINISTIC_MAX = 20
const DEFAULT_HARD_FLOOR = 1

/** Default stop-word set for the keyword pre-filter. Hungarian + English common words. */
const STOP_WORDS = new Set([
  // hu
  'a', 'az', 'és', 'vagy', 'de', 'hogy', 'egy', 'is', 'meg', 'már', 'még', 'ha', 'ha',
  'nem', 'igen', 'mit', 'hogy', 'hogyan', 'mikor', 'hol', 'mely', 'melyik',
  'ez', 'ezt', 'ezek', 'ezen', 'az', 'azt', 'azok', 'azon', 'akkor', 'ott',
  'ide', 'oda', 'így', 'úgy', 'mert', 'mivel', 'ha', 'amíg', 'mielőtt', 'miután',
  'kell', 'kellene', 'szerint', 'nélkül', 'ellen', 'felé', 'részére',
  // en
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'where',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'will', 'would', 'should', 'could', 'may', 'might',
  'this', 'that', 'these', 'those', 'it', 'its', 'i', 'you', 'he', 'she', 'we', 'they',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'as', 'from', 'into',
])

/**
 * Tokenize a string for keyword matching: lowercase, split on non-alphanumeric
 * (Unicode-aware so Hungarian diacritics survive), drop stop-words and very
 * short tokens (< 2 chars).
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9áéíóöőúüű]+/u)
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t))
}

/**
 * Score a chunk by how many of its tokens also appear in the query.
 * Cheap, deterministic, free of any model call.
 *
 * Score is normalized to [0, 1] by query length so longer queries do not
 * systematically outrank shorter ones. Ties are broken by token-overlap ratio.
 */
function keywordScore(query: string, content: string): number {
  const qTokens = tokenize(query)
  if (qTokens.length === 0) return 0
  const cTokens = new Set(tokenize(content))
  if (cTokens.size === 0) return 0
  let hits = 0
  for (const t of qTokens) {
    if (cTokens.has(t)) hits++
  }
  return hits / qTokens.length
}

/**
 * Pre-filter `chunks` by deterministic keyword score. Returns chunks sorted
 * by score descending; drops chunks with zero hits when `dropZero=true`.
 *
 * Pure function -- no model call, no I/O. Same input -> same output.
 */
export function deterministicPreFilter(
  query: string,
  chunks: readonly RelevanceChunk[],
  opts: { dropZero?: boolean } = {},
): RelevanceResult[] {
  const scored = chunks.map(c => ({
    id: c.id,
    score: keywordScore(query, c.content),
  }))
  scored.sort((a, b) => b.score - a.score)
  return opts.dropZero ? scored.filter(r => r.score > 0) : scored
}

/**
 * Run the full Context Gate pipeline on `candidates` for `query`.
 *
 * Returns ranked RelevanceResult[] (descending by score). The caller decides
 * whether to use `result.map(r => byId.get(r.id))` to materialize the chunks
 * or to call `assembleContext()` to get a joined string.
 *
 * On total failure (relevance filter errors AND keyword score empty) the
 * gate returns the input chunks in their original order with score 0, so
 * the cloud call still gets SOMETHING rather than nothing.
 */
export async function gateContext(
  query: string,
  candidates: readonly RelevanceChunk[],
  opts: GateContextOptions = {},
): Promise<RelevanceResult[]> {
  const topK = opts.topK ?? 5
  const deterministicMax = opts.deterministicMax ?? DEFAULT_DETERMINISTIC_MAX
  const hardFloor = opts.hardFloor ?? DEFAULT_HARD_FLOOR

  if (candidates.length === 0) return []
  if (candidates.length <= hardFloor) {
    return candidates.map((c, i) => ({ id: c.id, score: 1.0 - i * 0.01 }))
  }

  // ---- 1. Deterministic pre-filter ----
  let workingSet: RelevanceChunk[]
  let preFilterScores: Map<string, number>
  if (candidates.length <= deterministicMax) {
    // Small enough to skip the model call entirely.
    workingSet = [...candidates]
    preFilterScores = new Map(deterministicPreFilter(query, candidates).map(r => [r.id, r.score]))
  } else {
    const preFiltered = deterministicPreFilter(query, candidates, { dropZero: true })
    preFilterScores = new Map(preFiltered.map(r => [r.id, r.score]))

    if (preFiltered.length === 0) {
      // Deterministic pre-filter found nothing relevant -- fall back to the
      // top `deterministicMax` candidates by recency (input order) so the
      // Qwen filter has at least something to look at.
      logger.warn(
        { query: query.slice(0, 80), candidateCount: candidates.length },
        'context-gate: deterministic pre-filter dropped everything, falling back to top-by-input-order',
      )
      workingSet = candidates.slice(0, deterministicMax)
    } else if (preFiltered.length <= deterministicMax) {
      workingSet = preFiltered
        .map(r => candidates.find(c => c.id === r.id)!)
        .filter(Boolean)
    } else {
      workingSet = preFiltered
        .slice(0, deterministicMax)
        .map(r => candidates.find(c => c.id === r.id)!)
        .filter(Boolean)
    }
  }

  // ---- 2. Qwen relevance filter ----
  let qwenResults: RelevanceResult[]
  try {
    qwenResults = await relevanceFilter(query, workingSet, {
      ...opts,
      topK: Math.min(topK, workingSet.length),
    })
  } catch (err) {
    logger.warn(
      { err, query: query.slice(0, 80) },
      'context-gate: relevanceFilter threw, falling back to deterministic scores',
    )
    qwenResults = workingSet.map((c, i) => ({
      id: c.id,
      score: preFilterScores.get(c.id) ?? 0,
    }))
  }

  if (qwenResults.length === 0) {
    // Total failure: degrade gracefully, return input order with zero scores.
    logger.warn(
      { query: query.slice(0, 80) },
      'context-gate: relevance filter returned empty, returning input order',
    )
    return candidates.map((c, i) => ({ id: c.id, score: 0 }))
  }

  // Apply hard floor: never return fewer than `hardFloor` results if there
  // were any candidates at all.
  if (qwenResults.length < hardFloor && candidates.length >= hardFloor) {
    const extra = candidates
      .filter(c => !qwenResults.some(r => r.id === c.id))
      .slice(0, hardFloor - qwenResults.length)
      .map((c, i) => ({ id: c.id, score: -0.01 * (i + 1) }))
    return [...qwenResults, ...extra].slice(0, topK)
  }

  return qwenResults
}

/**
 * Join the contents of the top-K results (in order) into a single string.
 * Returns null if the gate returned no results or none of the IDs matched
 * the original candidates.
 *
 * The `separator` defaults to a blank line + comment header showing the
 * chunk id, so the assembled context is self-describing when it reaches the
 * cloud model.
 */
export function assembleContext(
  results: readonly RelevanceResult[],
  candidates: readonly RelevanceChunk[],
  opts: { separator?: string; includeHeader?: boolean } = {},
): string | null {
  if (results.length === 0) return null
  const byId = new Map(candidates.map(c => [c.id, c]))
  const separator = opts.separator ?? '\n\n'
  const includeHeader = opts.includeHeader ?? true

  const parts: string[] = []
  for (const r of results) {
    const chunk = byId.get(r.id)
    if (!chunk) continue
    if (includeHeader) {
      parts.push(`<!-- chunk: ${chunk.id} | relevance: ${r.score.toFixed(2)} -->`)
    }
    parts.push(chunk.content)
  }

  return parts.length > 0 ? parts.join(separator) : null
}
