// qwen-router.ts -- unified `complete()` interface that routes between the
// self-hosted Qwen 2.5 3B (free, ~4.6 tok/s on the LAN Ollama at .53) and
// Anthropic, driven by `cost`/`priority` flags.
//
// Why a router and not direct Ollama calls scattered across the codebase:
//   - One place to tune the routing policy (e.g. later: latency, fallback chain)
//   - One place to add per-provider cost / latency telemetry
//   - One place to make "Qwen unreachable -> degrade to Anthropic" cheap
//
// Why Qwen for the default low-cost path:
//   - Self-hosted on the LAN Ollama, zero marginal cost per call
//   - 3B is good enough for classify/summarize/short drafts; reasoning-heavy
//     workloads still go to Anthropic
//   - Saves Anthropic budget for tasks that earn it
//
// Integration: this module is intentionally side-effect free. Wiring the
// `complete()` call into agent.ts / heartbeat.ts / gmail-api.ts is a separate
// step each caller takes when it has a concrete cost-critical call site --
// until then the router is callable but unused.
//
// Reference: tested 2026-08-19, qwen2.5:3b on 192.168.1.53:11434 ~ 27s / 127
// tokens (~4.6 tok/s). Not user-facing realtime; fine for batch.

import { OLLAMA_URL } from './config.js'
import { logger } from './logger.js'
import {
  getRelevanceFilterCallCount,
  getRelevanceFilterMetrics,
  recordRelevanceFilterCall,
  reloadRelevanceFilterMetricsForTest,
} from './metrics/relevance-filter-metrics.js'

export { getRelevanceFilterCallCount, getRelevanceFilterMetrics, reloadRelevanceFilterMetricsForTest }

export type RoutingCost = 'low' | 'medium' | 'high'
export type RoutingPriority = 'low' | 'normal' | 'high' | 'critical'

export interface CompleteOptions {
  /** 'low' = try Qwen first (cheapest); 'high' = skip to Anthropic. */
  cost?: RoutingCost
  /** 'critical' = always Anthropic; 'low' = OK to use Qwen. */
  priority?: RoutingPriority
  /** Override the Qwen model tag (defaults to DEFAULT_QWEN_MODEL). */
  qwenModel?: string
  /** Max tokens to generate. Defaults differ by provider. */
  maxTokens?: number
  temperature?: number
  /** Do not fall back to Anthropic when the local Ollama call fails. */
  localOnly?: boolean
}

export interface CompleteResult {
  text: string
  provider: 'qwen' | 'anthropic'
  elapsedMs: number
  /** True when the caller asked for Qwen, Qwen failed, and we fell back. */
  fallback: boolean
}

const DEFAULT_QWEN_MODEL = 'qwen2.5:3b'
const QWEN_TIMEOUT_MS = 90_000 // CPU-only Ollama on the .53 needs headroom
const QWEN_DEFAULT_MAX_TOKENS = 256
const ANTHROPIC_DEFAULT_MAX_TOKENS = 1024

interface OllamaResponse {
  response?: string
  error?: string
  done?: boolean
}

export interface OllamaCaller {
  (prompt: string, opts: CompleteOptions, model: string, timeoutMs: number): Promise<string>
}

export interface AnthropicCaller {
  (prompt: string, opts: CompleteOptions, maxTokens: number): Promise<string>
}

let ollamaCaller: OllamaCaller = defaultOllamaCaller
let anthropicCaller: AnthropicCaller | null = null

/** Replace the Ollama implementation (used by tests). */
export function setOllamaCaller(caller: OllamaCaller): void {
  ollamaCaller = caller
}

/** Late-bind the Anthropic caller. Wires from agent.ts to avoid an import cycle. */
export function registerAnthropicCaller(caller: AnthropicCaller): void {
  anthropicCaller = caller
}

async function defaultOllamaCaller(
  prompt: string,
  opts: CompleteOptions,
  model: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature: opts.temperature ?? 0.3,
          num_predict: opts.maxTokens ?? QWEN_DEFAULT_MAX_TOKENS,
        },
      }),
      signal: controller.signal,
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(`Ollama HTTP ${resp.status}: ${body.slice(0, 200)}`)
    }
    const data = (await resp.json()) as OllamaResponse
    if (data.error) throw new Error(`Ollama error: ${data.error}`)
    if (data.response == null) throw new Error('Ollama returned empty response')
    return data.response
  } finally {
    clearTimeout(timer)
  }
}

function preferQwen(opts: CompleteOptions): boolean {
  if (opts.cost === 'high') return false
  if (opts.priority === 'critical') return false
  return true
}

/** Route a `complete()` call. Always resolves; never throws across providers. */
export async function complete(prompt: string, opts: CompleteOptions = {}): Promise<CompleteResult> {
  const start = Date.now()
  const model = opts.qwenModel ?? DEFAULT_QWEN_MODEL

  if (preferQwen(opts)) {
    try {
      const text = await ollamaCaller(prompt, opts, model, QWEN_TIMEOUT_MS)
      return { text, provider: 'qwen', elapsedMs: Date.now() - start, fallback: false }
    } catch (err) {
      logger.warn({ err, model, localOnly: opts.localOnly === true }, 'qwen-router: ollama call failed')
      if (opts.localOnly) throw err
    }
  }

  if (!anthropicCaller) {
    throw new Error(
      'qwen-router: Anthropic caller not registered. Call registerAnthropicCaller() at boot, ' +
      'or pass cost: "low" without an anthropic fallback (qwen will be used).',
    )
  }
  const text = await anthropicCaller(prompt, opts, opts.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS)
  return {
    text,
    provider: 'anthropic',
    elapsedMs: Date.now() - start,
    fallback: preferQwen(opts), // we tried Qwen first and fell back
  }
}

/**
 * Convenience: classify a string into one of `labels`.
 * Returns the label chosen by the model. Cheaper than `complete()` because
 * the prompt is short and num_predict is forced to 1.
 */
export async function classify(
  text: string,
  labels: readonly string[],
  opts: CompleteOptions = {},
): Promise<string> {
  return (await classifyWithCompletion(text, labels, opts)).label
}

async function classifyWithCompletion(
  text: string,
  labels: readonly string[],
  opts: CompleteOptions,
): Promise<{ label: string; completion: CompleteResult }> {
  const list = labels.map((l, i) => `${i + 1}. ${l}`).join('\n')
  const prompt = `Kategorizáld az alábbi szöveget a megadott címkék egyikébe. Csak a számot add vissza (1-${labels.length}), semmi mást.\n\nCímkék:\n${list}\n\nSzöveg:\n${text.slice(0, 2000)}\n\nVálasz:`
  const completion = await complete(prompt, { ...opts, maxTokens: 4, temperature: 0 })
  const m = completion.text.trim().match(/^(\d+)/)
  if (!m) return { label: labels[0], completion }
  const idx = parseInt(m[1], 10) - 1
  return { label: labels[idx] ?? labels[0], completion }
}

// =============================================================================
// Context Gate relevance filter (Phase 2 / TASK-0011)
//
// The Context Gate pipeline (PROJECT_MEMORY.md "Routing") feeds every cloud
// call through a local-relevance step BEFORE the prompt leaves the box: the
// deterministic search + vector retrieval return N candidate chunks, and the
// 3B Qwen on the LAN filters them down to the top-K that actually answer the
// query. The cloud model then sees a small, dense context instead of a noisy
// dump -- the cost win is the difference between "send 50 KB of context" and
// "send 2 KB of pre-filtered context".
//
// Design notes:
//   - Batch-first (one round-trip). A 3B model is small enough that structured
//     JSON output is flaky, so the batch path is wrapped in a JSON parse: if
//     the model freeforms a preamble or wraps the array in markdown fences,
//     we fall back to per-chunk classify().
//   - The fallback path costs N round-trips (one classify per chunk), so it is
//     genuinely a slow path. Callers that pre-filter to <=20 chunks are fine;
//     callers passing 100+ chunks should pre-trim themselves first.
//   - The router's existing provider fallback (Qwen -> Anthropic) still
//     applies: if the LAN Ollama is down, this whole function transparently
//     escalates to the registered Anthropic caller for the relevance call.
// =============================================================================

/** A unit of context passed to the relevance filter. */
export interface RelevanceChunk {
  /** Stable id (e.g. file:line, memory id, retriever key). Echoed in the result. */
  id: string
  /** The text the model should score. */
  content: string
}

/** One scored chunk returned by the relevance filter. */
export interface RelevanceResult {
  /** The id of the source chunk. */
  id: string
  /** Relevance score in [0.0, 1.0]; higher = more relevant. */
  score: number
}

/** Options for `relevanceFilter`. Extends `CompleteOptions` with `topK`. */
export interface RelevanceFilterOptions extends CompleteOptions {
  /** Maximum number of chunks to return. Defaults to 5. */
  topK?: number
  /** Disable the N-call per-chunk retry; intended for bounded probes. */
  perChunkFallback?: boolean
  /** Reports the provider only after a complete, valid batch was accepted. */
  onBatchProvider?: (provider: CompleteResult['provider']) => void
}

const DEFAULT_RELEVANCE_TOP_K = 5
const RELEVANCE_BATCH_MAX_TOKENS = 400
const RELEVANCE_BATCH_PROMPT_CHUNK_CHARS = 500
const RELEVANCE_BATCH_PROMPT_QUERY_CHARS = 500
const RELEVANCE_FALLBACK_CONTENT_CHARS = 200

/**
 * Ranks `chunks` by relevance to `query` and returns the top-K.
 *
 * Behaviour:
 *   1. Empty input -> empty result (no model call).
 *   2. Batch path: a single prompt asks the model to return the top-K as JSON.
 *      If the response does not parse as a JSON array of {id, score}, OR
 *      fewer than topK valid items come back, the function logs and falls back
 *      to the per-chunk path so the caller still gets SOMETHING sorted.
 *   3. Per-chunk fallback: one `classify()` call per chunk with the labels
 *      ['releváns', 'nem releváns']; relevant = 0.5, not relevant = 0.0.
 *      Returned sorted descending, sliced to topK.
 *
 * NEVER throws; on total failure (both paths error) returns an empty array
 * so the Context Gate can degrade to "no pre-filter" rather than abort the
 * surrounding cloud call.
 */
export async function relevanceFilter(
  query: string,
  chunks: readonly RelevanceChunk[],
  opts: RelevanceFilterOptions = {},
): Promise<RelevanceResult[]> {
  let outcome: RelevanceFilterOutcome | undefined
  try {
    outcome = await runRelevanceFilter(query, chunks, opts)
    return outcome.results
  } finally {
    recordRelevanceFilterCall(outcome?.failed ?? chunks.length > 0)
  }
}

interface RelevanceFilterOutcome {
  results: RelevanceResult[]
  /** The filter requested local Qwen but obtained no usable result from it. */
  failed: boolean
}

async function runRelevanceFilter(
  query: string,
  chunks: readonly RelevanceChunk[],
  opts: RelevanceFilterOptions,
): Promise<RelevanceFilterOutcome> {
  const topK = opts.topK ?? DEFAULT_RELEVANCE_TOP_K
  if (chunks.length === 0) return { results: [], failed: false }
  let qwenAttempted = false
  let qwenSucceeded = false

  // ---- Batch path (1 round-trip) ----
  const batchPrompt = buildRelevanceBatchPrompt(query, chunks, topK)
  try {
    const batchResult = await complete(batchPrompt, {
      ...opts,
      maxTokens: RELEVANCE_BATCH_MAX_TOKENS,
      temperature: 0,
    })
    const parsed = parseRelevanceBatchResponse(batchResult.text, chunks, topK)
    if (parsed.length >= Math.min(topK, chunks.length)) {
      opts.onBatchProvider?.(batchResult.provider)
      qwenAttempted = batchResult.provider === 'qwen' || batchResult.fallback
      qwenSucceeded = batchResult.provider === 'qwen'
      return { results: parsed.slice(0, topK), failed: qwenAttempted && !qwenSucceeded }
    }
    qwenAttempted = batchResult.provider === 'qwen' || batchResult.fallback
    logger.warn(
      { batchLength: parsed.length, wanted: Math.min(topK, chunks.length) },
      'qwen-router: relevance batch returned fewer items than asked, falling back to per-chunk',
    )
  } catch (err) {
    qwenAttempted = preferQwen(opts)
    logger.warn(
      { err, chunkCount: chunks.length },
      'qwen-router: relevance batch path failed, falling back to per-chunk',
    )
  }

  if (opts.perChunkFallback === false) {
    return { results: [], failed: qwenAttempted && !qwenSucceeded }
  }

  // Keep an explicit Anthropic-only caller policy intact. The historical
  // low-cost fallback is appropriate only when the caller did not demand the
  // strong/cloud route; otherwise a malformed batch must not secretly probe
  // Qwen or attribute a Qwen failure.
  const perChunkOpts = opts.cost === 'high' ? opts : { ...opts, cost: 'low' as const }
  const scored: RelevanceResult[] = []
  for (const chunk of chunks) {
    let score = 0.0
    try {
      const classified = await classifyWithCompletion(
        `Query: ${query.slice(0, RELEVANCE_FALLBACK_CONTENT_CHARS)}\n\nChunk ${chunk.id}: ${chunk.content.slice(0, RELEVANCE_FALLBACK_CONTENT_CHARS)}`,
        ['releváns', 'nem releváns'],
        perChunkOpts,
      )
      qwenAttempted = qwenAttempted || classified.completion.provider === 'qwen' || classified.completion.fallback
      qwenSucceeded = qwenSucceeded || classified.completion.provider === 'qwen'
      score = classified.label === 'releváns' ? 0.5 : 0.0
    } catch (err) {
      qwenAttempted = qwenAttempted || preferQwen(perChunkOpts)
      logger.warn({ err, chunkId: chunk.id }, 'qwen-router: per-chunk classify failed, score=0')
      score = 0.0
    }
    scored.push({ id: chunk.id, score })
  }
  return {
    results: scored.sort((a, b) => b.score - a.score).slice(0, topK),
    failed: qwenAttempted && !qwenSucceeded,
  }
}

function buildRelevanceBatchPrompt(query: string, chunks: readonly RelevanceChunk[], topK: number): string {
  const chunkList = chunks
    .map((c, i) => `${i + 1}. [${c.id}] ${c.content.slice(0, RELEVANCE_BATCH_PROMPT_CHUNK_CHARS)}`)
    .join('\n')
  return (
    `Rangsorold az alábbi szövegrészleteket a query-val való relevancia szerint (0.0-1.0 skálán, 1.0 = tökéletesen releváns). ` +
    `Adj vissza egy JSON tömböt a top-${topK} legrelevánsabb chunk-ról, csökkenő sorrendben: ` +
    `[{"id": "<chunk_id>", "score": <0.0-1.0>}, ...]. Csak a JSON-t add vissza, semmi mást.\n\n` +
    `Query: ${query.slice(0, RELEVANCE_BATCH_PROMPT_QUERY_CHARS)}\n\n` +
    `Chunks:\n${chunkList}\n\n` +
    `Válasz (csak JSON):`
  )
}

function parseRelevanceBatchResponse(
  text: string,
  chunks: readonly RelevanceChunk[],
  topK: number,
): RelevanceResult[] {
  const arrayMatch = text.match(/\[[\s\S]*\]/)
  if (!arrayMatch) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(arrayMatch[0])
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const knownIds = new Set(chunks.map((c) => c.id))
  const results: RelevanceResult[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const id = (item as { id?: unknown }).id
    const score = (item as { score?: unknown }).score
    if (typeof id !== 'string' || !knownIds.has(id)) continue
    if (typeof score !== 'number' || Number.isNaN(score)) continue
    const clamped = Math.max(0, Math.min(1, score))
    results.push({ id, score: clamped })
    if (results.length >= topK) break
  }
  return results
}
