# Task observability (TASK-0030)

TASK-0030 adds an append-only `task_observability_events` SQLite ledger. It
does not backfill existing cards, token rows, task runs, or canary logs.
Consequently it cannot and does not claim historical FPY.

Each row has a stable `event_id`, a queryable `correlation_id`, optional
`task_id` and `session_id`, a versioned provenance string, millisecond event
time, a per-task monotonic transition sequence, kind, and bounded JSON metadata. Metadata is allowlisted and limited to
2048 UTF-8 bytes; recall query text, memory contents, prompts, actor names,
and model output text are never stored.

Canonical TASK-0019 transitions write their existing card update, legacy
`kanban_card_events` audit, and observation event in the same immediate
transaction. The audit row contains the matching correlation and observation
event IDs. Reorders and rejected transitions emit nothing.

TASK-0023 canary executions persist their fixed-fixture counts and outcome.
Opt-in real recall gate executions persist only input/output counts, top-K,
whether they failed open. Caller-provided task, session, and correlation
headers are unauthenticated assertions, so routes ignore them: recall rows are
non-correlatable and workflow task identity is bound to the server-selected card.
The existing default-off and fail-open behavior is unchanged.

Generate a future measured snapshot with:

```bash
npx tsx scripts/aggregate-task-observability.ts \
  --db /path/to/claudeclaw.db \
  --output /tmp/task-observability.json
```

The atomic JSON output uses `task-observability-metrics.v1`. Its FPY cohort
requires a fully observed, monotonic `running -> verify -> done` sequence. A task is a
first-pass success only if that measured interval contains no `repair` event.
Before any eligible sequence exists, `first_pass_yield` is `null`, never zero.
The output also reports Context Gate outcomes and coverage/limitations.

## Planned production canary (not performed)

1. Back up the SQLite database and deploy through the normal reviewed release
   process with `CONTEXT_GATE_CANARY_ENABLED=0`; restart once so the additive
   migration runs. Confirm the new table is empty and ordinary recall matches
   the pre-release response contract.
2. Exercise one non-production-style workflow card through a real allowed
   transition. Confirm its `kanban_card_events.correlation_id` resolves to one
   `workflow_transition` row with the same task ID.
3. Enable the existing canary toggle, restart, and send one authenticated
   canary POST. Confirm one `context_gate_measurement` row with TASK-0023
   provenance. Then make one explicitly tagged opt-in recall request and
   confirm counts only—no query or memory text—were persisted.
4. Generate the metrics JSON. Accept `first_pass_yield: null` until a complete
   real cohort exists; do not reinterpret missing history as failure or success.

## Rollback

Disable `CONTEXT_GATE_CANARY_ENABLED` and restart to stop canary calls. Roll
back application code through the normal release process. Leave the additive
table and nullable audit columns in place so rollback is compatible and
collected evidence is preserved; a later approved cleanup may archive/drop
them. Recall observation failure only logs and preserves fail-open recall.
