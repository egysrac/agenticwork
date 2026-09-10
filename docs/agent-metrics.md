# Agent metrics aggregation (TASK-0021)

Generate the all-time, per-agent JSONL snapshot from an existing SQLite database:

```bash
npx tsx scripts/aggregate-agent-metrics.ts \
  --db /path/to/claudeclaw.db \
  --output metrics/agent_metrics.jsonl
```

`--db` is deliberately required. The default output is
`metrics/agent_metrics.jsonl`. The command opens the database read-only and
atomically replaces the output. With unchanged input and the same paths,
repeated runs are byte-identical. No model or LLM is used.

All SQLite `INTEGER` source facts and derived aggregates are emitted as JSON
numbers only when they are within JavaScript's exact safe-integer range
(`-9007199254740991` through `9007199254740991`). The command fails before
replacing the output if a source value or aggregate falls outside that range;
it never silently rounds an integer. Output paths resolving to the source
database or its `-wal`, `-shm`, or `-journal` companions (including symlink or
hardlink aliases) are also rejected before the database is opened.

The schema version is `agent-metrics.v1`; its grain is one all-time row per
agent found in `token_usage` or `task_runs`. Each row embeds the exact SQL,
required source schema, aggregation version, database provenance, full-table
source counts, and deterministic ordering rule.

## Limitations

`token_usage` supports recorded-call and token totals, session counts, nullable
model coverage, and observation bounds. `task_runs` supports scheduler-event
counts, names, statuses, and timestamp bounds. A token row cannot be reliably
joined to a task run because there is no task/session foreign key.

Therefore historical task IDs, complexity, verified result, local/cloud/strong
model tiers, repair attempts, file counts, test outcomes, first-pass yield, and
lead time are explicitly `null` with machine-readable reasons. In particular,
`task_runs.status` is not treated as a verified task result, and no historical
FPY or repair data is inferred. Trustworthy task-level values require future
runtime instrumentation of VERIFY/REPAIR and task lifecycle events.
