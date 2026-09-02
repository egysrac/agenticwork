// Pure logic for Dynamic Model Escalation (Phase 4).
//
// Picks between an L2 (default, cheaper) and an L3 (stronger, more expensive)
// model for a single request, based on the input token size. This is the
// "escalation" half of the L2/L3 split that was previously just env-configured
// (Phase 2): instead of pinning a model per agent forever, every call now
// decides its model from the same data the cost monitor sees (input tokens).
//
// The cost monitor (estimateCost) lives next to the selector so a future
// caller can pick a model not only by size but by the dollar budget the
// caller is willing to spend, with the two halves sharing one rate table.
//
// Pure + dependency-free so it can be unit-tested without spinning up the
// dashboard or touching the filesystem. The runtime integration point will be
// agent-process.ts (read the prompt token estimate, call selectModel, then
// pass the chosen id to the --model flag), wired in a follow-up once the
// data-flow is validated.

export interface EscalationConfig {
  /** L2 (default) model id. */
  l2Model: string
  /** L3 (fallback / escalated) model id. */
  l3Model: string
  /** Input token count at or above which the call is escalated to L3. */
  threshold: number
  /** Cost per 1K input tokens for L2 (USD). */
  costL2InputPer1k: number
  /** Cost per 1K output tokens for L2 (USD). */
  costL2OutputPer1k: number
  /** Cost per 1K input tokens for L3 (USD). */
  costL3InputPer1k: number
  /** Cost per 1K output tokens for L3 (USD). */
  costL3OutputPer1k: number
}

// Defaults mirror the install's actual .env (L2 = Sonnet, L3 = Opus). Rates are
// placeholders for the cost monitor -- they will be tuned from real token
// usage once the dashboard records a few days of data, but the shape is fixed.
export const DEFAULT_ESCALATION_CONFIG: EscalationConfig = {
  l2Model: 'claude-sonnet-4-6',
  l3Model: 'claude-opus-4-6',
  threshold: 8000,
  costL2InputPer1k: 0.003,
  costL2OutputPer1k: 0.015,
  costL3InputPer1k: 0.015,
  costL3OutputPer1k: 0.075,
}

/**
 * Pure: choose the model for a request based on the input token count.
 *   inputTokens >= threshold -> L3 (stronger)
 *   otherwise                -> L2 (default)
 */
export function selectModel(
  inputTokens: number,
  cfg: EscalationConfig = DEFAULT_ESCALATION_CONFIG,
): string {
  if (!Number.isFinite(inputTokens) || inputTokens < 0) return cfg.l2Model
  return inputTokens >= cfg.threshold ? cfg.l3Model : cfg.l2Model
}

/**
 * Pure: estimate the USD cost of a call given the model and token counts.
 * Unknown models fall back to L2 rates (cheapest side) so a misconfig never
 * silently over-estimates.
 */
export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  model: string,
  cfg: EscalationConfig = DEFAULT_ESCALATION_CONFIG,
): number {
  const isL3 = model === cfg.l3Model
  const inRate = isL3 ? cfg.costL3InputPer1k : cfg.costL2InputPer1k
  const outRate = isL3 ? cfg.costL3OutputPer1k : cfg.costL2OutputPer1k
  const i = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0
  const o = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0
  return (i / 1000) * inRate + (o / 1000) * outRate
}

/** Human-readable one-line summary for logs / dashboard. */
export function describeEscalation(
  inputTokens: number,
  chosenModel: string,
  cfg: EscalationConfig = DEFAULT_ESCALATION_CONFIG,
): string {
  const escalated = chosenModel === cfg.l3Model
  return `${escalated ? 'ESCALATED' : 'kept'} on L${escalated ? '3' : '2'} ` +
    `(${chosenModel}) for ${inputTokens} input tokens (threshold=${cfg.threshold})`
}
