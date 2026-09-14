# TASK-0032: main-session auto-start recovery

## Root cause

Scheduled tasks resolve the configured main agent to the canonical
`${MAIN_AGENT_ID}-channels` tmux session. When that session was absent,
`attemptFireTask` nevertheless called the profile-managed sub-agent launcher.
The launcher requires `agents/<id>`; the main agent intentionally has no such
directory, so auto-start returned `Agent not found` and run-now stayed missing.

## Fix

For the configured main agent's canonical target only, the missing-session path
now calls `createMainChannelsSession()`. That existing helper launches
`scripts/channels.sh` and applies a six-minute creation grace. `started` and
`grace` are both treated as one in-flight start: no prompt is injected while the
session boots, and the task is kept in the deduplicated pending-retry queue.
Once the canonical session exists and is ready, the normal retry path performs
the single delivery.

Sub-agents and explicit `targetSession` overrides retain their existing launch
behavior. File-preparation tasks retain the TASK-0031 no-send prompt and output
verification behavior.

## Verification and safety

The regression tests mock session existence, the channels creator, prompt
injection, and the retry store. They cover first creation, the single-flight
grace case, absence of premature/duplicate prompt injection, and the durable
retry. No live tmux session or channel is touched.

## Rollback

Revert the TASK-0032 conditional in `attemptFireTask`, its two regression tests,
and this document. This restores the prior missing-session behavior; no data
migration or configuration rollback is required. Pending retry rows remain
valid and can be processed by either version.
