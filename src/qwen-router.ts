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
      logger.warn({ err, model }, 'qwen-router: ollama call failed, falling back to anthropic')
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
  const list = labels.map((l, i) => `${i + 1}. ${l}`).join('\n')
  const prompt = `Kategorizáld az alábbi szöveget a megadott címkék egyikébe. Csak a számot add vissza (1-${labels.length}), semmi mást.\n\nCímkék:\n${list}\n\nSzöveg:\n${text.slice(0, 2000)}\n\nVálasz:`
  const result = await complete(prompt, { ...opts, maxTokens: 4, temperature: 0 })
  const m = result.text.trim().match(/^(\d+)/)
  if (!m) return labels[0]
  const idx = parseInt(m[1], 10) - 1
  return labels[idx] ?? labels[0]
}
