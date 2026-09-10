# Kanban execution-lane policy (TASK-0018)

## Configuration and rollout

`KANBAN_LANE_WIP_LIMIT` (default 1; 0 means unlimited; maximum 100) and
`KANBAN_LANE_WIP_ENFORCE` (default `0`, canary) **require restart**. The
Settings registry marks both accordingly. Saving an override does not change
the active policy until database initialization. Other Kanban settings retain
their existing hot-reload behavior.

This is an intentional change from the initial TASK-0018 hot-reload proposal:
persistent SQLite triggers must work on plain independent connections. They
cannot call connection-local JavaScript functions or read a process's settings
cache. Atomically coordinating a filesystem override/watch event with every
SQLite writer would require a different settings storage contract. Instead,
initialization resolves `config-overrides.json > .env > registry default` and
publishes all six lanes in `kanban_lane_policy` in the same exclusive transaction
as lane migration and trigger installation. HTTP routes read this committed SQL
snapshot, not pending settings-store values.

Advanced `.env` keys `KANBAN_LANE_WIP_LIMIT_<LANE>` override the resolved global
limit for that lane and also require restart. Invalid lane-specific values fall
back to the global limit. They are not separate Settings UI entries.

For multiple application processes sharing one DB, stop/quiesce writers and
restart all processes with the **same configuration** when changing policy.
Every `initDatabase` publishes its configuration atomically; do not use rolling
restarts with conflicting configuration. Plain SQLite connections need no
initialization functions beyond opening the already initialized database.

Begin in canary, observe HTTP `wip_warning`/logs over a measured traffic window,
then explicitly enable enforcement and restart after review. Raw SQL overfill
is allowed in canary but does not emit an HTTP warning or application log.
This patch has not performed a production canary or authorized enforcement.

## Integrity and compatibility

- New `in_progress` starts require a valid lane even in canary. Existing untouched
  lane-null running rows remain editable/reorderable and do not consume lane WIP.
- Persistent SQL triggers guard inserts, status/lane transitions, and unarchive.
  Existing occupants can still be edited when a lane is already over its limit.
- Lane migration is transactional and preserves rowid (`#seq`), including gaps.
- Application create/move/update/unarchive gates use immediate transactions.
  Their explicit caller options can be stricter than SQL policy, but cannot
  relax enforced SQL constraints. HTTP callers obtain options from SQL policy.
- Fleet restore preserves valid snapshot lanes and old lane-null running rows,
  including snapshots already over capacity. The exemption exists only during
  `insertImportedKanbanCard`'s transaction (a savepoint inside an outer restore).
  The flag is deleted before commit; any failure rolls it back with the insert.
  Competing connections cannot see its uncommitted state or obtain the writer
  lock while it exists. Caught failures inside an outer transaction do not leak
  an exemption. Duplicate IDs are ignored; malformed nonduplicate rows fail.
- SQLite is not a privilege boundary: a writer with arbitrary DDL/DML access
  can alter policy/flags or drop triggers. Only trusted code should write these
  internal tables. No durable import mode is supported.

Lease governance is separate and is not implemented by this repair. Independent
review and measured canary evidence are still required before rollout.
