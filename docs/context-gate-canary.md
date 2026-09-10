# Context Gate canary (TASK-0023)

The canary is a disabled-by-default, authenticated `POST /api/recall/context-gate-canary` endpoint. It uses one fixed server-side query and three small fixed candidates. Request parameters and bodies cannot broaden the input. Normal `GET /api/recall`, including its existing `gate=true` opt-in, is unchanged.

TASK-0030 additionally persists each accepted run in the no-backfill task
observation ledger with stable correlation/event IDs; see
`docs/task-observability.md`. This adds measurement only and does not alter the
fixed input, routing, ranking, or fail-open result.

The endpoint attempts one Qwen batch call. Both cloud fallback and per-candidate retry are disabled. If local Qwen fails or returns an unusable response, the endpoint returns all three fixture candidates (`outcome: "fail_open"`). Every accepted request emits the structured event `context_gate_canary.completed.v1` with process-lifetime counter `context_gate_canary_requests_total`, outcome, bounded input sizes, output IDs, and provenance `TASK-0023` / `server_fixture.v1` / `local_qwen_only`. Separate relevance-filter call/failure totals are persisted in a SQLite counter database so concurrent dashboard processes cannot overwrite one another. The failure counter measures local Qwen health independently of filter availability: a Qwen-to-Anthropic fallback can return a valid relevance result while still recording the failed Qwen attempt, whereas an explicitly Anthropic-only call is not a Qwen failure. The canary remains `localOnly`, so its own failures still fail open with no cloud call.

## Production canary procedure (proposed; do not deploy as part of TASK-0023)

1. Deploy the reviewed code through the normal release process with `CONTEXT_GATE_CANARY_ENABLED=0` (the default), then restart and confirm the endpoint returns 404 with `context_gate_canary_disabled`.
2. Set `CONTEXT_GATE_CANARY_ENABLED=1` through the dashboard Settings page and restart the dashboard service.
3. Send exactly one authenticated request: `curl -fsS -X POST -H "Authorization: Bearer $DASHBOARD_TOKEN" http://127.0.0.1:3420/api/recall/context-gate-canary`.
4. Confirm the JSON and structured application log both contain `event=context_gate_canary.completed.v1`, `metric.name=context_gate_canary_requests_total`, `metric.value=1`, and the expected provenance. Accept `qwen_success`; investigate `fail_open` while noting that no cloud fallback occurred.
5. Send no additional requests unless another explicitly approved sample is needed. Confirm ordinary `GET /api/recall` responses remain unchanged and do not contain canary metadata.

## Rollback

Set `CONTEXT_GATE_CANARY_ENABLED=0` in the dashboard Settings page and restart the dashboard service. Verify the POST endpoint again returns 404. This stops canary traffic without changing ordinary recall behavior. If code rollback is also required, use the normal release rollback after disabling the toggle.
