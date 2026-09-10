# TASK-0031: morning preparation completion safeguard

`reggeli-napindito` and `dream-engine` are file-preparation tasks. A scheduler
`fired` row only proves that a prompt was injected; it does not prove that
`MORNING.md` or `DREAM.md` was
created or refreshed. The target session can accept the keys, run a short turn,
and return idle while leaving yesterday's file untouched.

The runner snapshots the configured, allowlisted output before either named
task is injected.
When the observed turn returns idle, success requires a changed file
fingerprint (size, mtime, and SHA-256 content), and the refreshed regular file
must contain at least one non-whitespace character. Missing, empty, or unchanged output
writes an `output-missing`, `output-empty`, or `output-stale` `task_runs` row and a durable
pending retry. A changed output clears normally. No Telegram send is performed
by this verifier; delivery remains the separate scripted send task.
The scheduler's task-specific prompt prefix and the task skill both explicitly
forbid Telegram delivery, making output-verification retries idempotent.

The policy is intentionally limited to the exact mappings
`reggeli-napindito` -> `MORNING.md` and `dream-engine` -> `DREAM.md`. Each task
must opt in with its exact `expectedOutputFile` value. The field is not a
free-form path and cannot execute arbitrary verification shell.
Session absence, startup, busy state, first-run dialogs, and MCP requirements
continue through the existing persistent retry/preflight paths.

The output obligation is committed to SQLite before prompt injection begins.
If prompt delivery throws, the matching obligation is removed and the task is
kept in the durable retry queue. Thus a crash after delivery can leave an extra
obligation to verify, but can never leave an injected preparation task with no
durable completion record.

## Rollback

Revert `schedule-output-verifier.ts` and its import, snapshot field, and
completion check in `schedule-runner.ts`. Remove the TASK-0031 tests and this
document. Do not alter the retry tables or run the morning send: no schema,
production configuration, or sent-message state is introduced by this change.
