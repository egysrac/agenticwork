# Historical metrics baseline (TASK-0022)

The baseline is a deterministic JSON document over an explicit UTC half-open
range (`[start,end)`). It reads the production-shaped `token_usage` (seconds)
and `task_runs` (milliseconds) tables through a read-only SQLite connection.
It does not use an LLM.

Every emitted numeric fact is an object containing `value`, the exact `sql`,
decimal-string `parameters`, and the explicit `time_range`. The document has
no generation timestamp, and agents and statuses use binary ordering, so an
unchanged database snapshot, path, and range produce byte-identical output.

The only reconstructable baseline facts are token-log rows, sessions and token
totals, model-field coverage, timestamp bounds, scheduler-event rows, distinct
scheduled-task names, and scheduler status counts. Scheduler status is not a
verified task outcome.

Historical task identity, complexity, verified outcomes, model tiers, repair
attempts, file/test counts, FPY, and lead time are `null` with explicit
reasons. An empty range has zero source-row counts and no agents, while those
unreconstructable metrics remain unknown rather than becoming zero. This is
the §40 rule: trustworthy FPY begins only after VERIFY/REPAIR runtime states
are enforced and recorded.

Production read-only generation (the database is opened with
`readonly: true`; output goes to `/tmp`, not the production tree):

```bash
cd /home/alex/marveen && npx tsx scripts/generate-historical-baseline.ts \
  --db /home/alex/marveen/store/claudeclaw.db \
  --start 1970-01-01T00:00:00Z \
  --end 2026-09-08T00:00:00Z \
  --output /tmp/task-0022-historical-baseline-before-2026-09-08.json
```

The end is exclusive. Change neither boundary when regenerating this named
baseline; a different range is a different baseline.
