# Context Gate canary (TASK-0023, 2026-09-08)

## What this is

TASK-0023 turns on the already-built Context Gate pipeline
(`src/context-gate.ts`, Phase 3 / TASK-0015..0017, 18/18 tests) for a small,
human-initiated, low-blast-radius slice of live traffic, and adds the counter
needed to prove it is actually running (CURRENT_STATE.yaml's
`qwen_relevance_filter_calls: 0` was a static compliance note, not a measured
value -- there was no counter behind it before this task).

**Scope of the canary: the dashboard recall UI only.** No scheduled task, no
script, no other caller was touched. `/api/recall`'s own server-side default
is unchanged: `gate` is still opt-in and OFF unless the caller sends
`?gate=true` (`src/web/routes/recall.ts:198`).

## What changed

### 1. Call counter (`src/qwen-router.ts`)

Added a counter around `relevanceFilter()` (the function that actually calls
qwen2.5:3b on the LAN Ollama, or falls back to Anthropic if that's down):

- `recordRelevanceFilterCall()` increments on every real invocation (i.e.
  every call with a non-empty candidate set -- the `chunks.length === 0`
  short-circuit does not count, since no model call is even attempted).
- Persisted best-effort (atomic write, same pattern as
  `store/command-task-health.json`) to `store/context-gate-relevance-metrics.json`:
  ```json
  { "schema_version": "context-gate-relevance-metrics.v1", "calls": 3, "lastCallAt": 1788869000000 }
  ```
- `getRelevanceFilterCallCount()` reads the current count (survives a
  process restart, since it's file-backed).
- A persistence failure only logs a warning -- it can never make
  `relevanceFilter()` throw, preserving the existing "never throws" contract
  the whole Context Gate design depends on.

Tests: `src/__tests__/qwen-router-relevance-metrics.test.ts` (5 tests, run in
an isolated worktree with `STORE_DIR` mocked into a sandbox temp dir --
see the file header for why an unmocked `STORE_DIR` in a test is dangerous).
Verified in `/home/alex/marveen-wt-task23`: 23/23 passing (5 new +
18 existing `context-gate.test.ts`), `tsc --noEmit` clean.

### 2. Canary traffic (`web/app.js`, `doRecall()`)

The dashboard's own recall search box now sends `gate=true` on **every 5th
text search** (searches with a `q` value; date-only browsing is untouched
because `maybeGateMemories()` no-ops without a query anyway). The counter
(`recallGateCanaryCount`) is a plain in-memory module variable -- it resets
on page reload, so the 1-in-5 ratio is approximate, not exact. That's fine
for a canary; it is not used for anything billing- or safety-critical.

## How to verify the counter is moving

```bash
cat /home/alex/marveen/store/context-gate-relevance-metrics.json
```

or, with the dashboard running:

```bash
curl -s "http://localhost:3420/api/recall?q=teszt&gate=true" | python3 -m json.tool
```

Each call with a non-trivial memory set (more than `gateTopK`, default 5,
matching results) increments `calls` by 1. A gate failure (Ollama
unreachable, malformed response, etc.) still increments the counter -- it
counts *attempts*, and `gateContext()`/`relevanceFilter()` degrade
gracefully rather than raising, so the caller gets an unfiltered result
instead of a 500.

## Rollback (one change, one file)

To go back to 100% OFF (no canary traffic at all), revert the `web/app.js`
change only -- **the server stays exactly as it always was**, nothing to
undo there:

- File: `web/app.js`
- Function: `doRecall()`
- Delete this block (added right after `if (agentInput) params.set('agent', agentInput)`):
  ```js
  if (searchInput) {
    recallGateCanaryCount += 1
    if (recallGateCanaryCount % RECALL_GATE_CANARY_EVERY_N === 0) params.set('gate', 'true')
  }
  ```
- Also delete the two `let`/`const` declarations added next to
  `let recallSortDesc = true`.

No restart is required to roll back `web/app.js` alone -- it is served as a
static asset and takes effect on the next page load.

The counter in `src/qwen-router.ts` can be left in place even after a
rollback; it is inert (never increments) once nothing sends `gate=true`
anymore, and it is harmless, additive instrumentation independent of the
canary itself.

## What is NOT done yet -- deploy step

This branch (`task23-context-gate-canary`, worktree
`/home/alex/marveen-wt-task23`) has the code, tests, and this doc, but the
**running `marveen-dashboard.service` has not been rebuilt or restarted**,
so none of this is live yet. That step was deliberately left for a separate
execution context: this task ran as a background task hosted *inside*
`marveen-dashboard.service`'s own systemd cgroup
(`KillMode=control-group`), so restarting that service from within this
process would `SIGTERM` this very task before it could finish reporting --
including before the required kanban comment. Deploying requires, from a
process outside that cgroup (a fresh shell, a different agent, or Alex
directly):

```bash
cd /home/alex/marveen
git fetch  # or merge task23-context-gate-canary directly if working from the worktree
npm run build
systemctl --user restart marveen-dashboard.service
```

Restarting this service also restarts every live agent tmux session hosted
under it (jarvis-worker, jarvis-worker-fast, and any other agents), so the
usual "not during dream-engine 02:07 or the 06:00 morning report" rule
applies, and whoever restarts it should expect their own session to
possibly reset (this project's SessionStart continuity ledger is designed
to handle exactly this).
