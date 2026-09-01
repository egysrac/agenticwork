---
name: marveen-agentic-dev
description: Marveen Agentic Operating System -- task dekompozíció, state machine, context gate, model routing, quality gate, retry policy, persistent state. Használd minden nem triviális TASK előtt (TASK-XXXX indítás, dekompozíció, verify, escalate, approval gate).
---

# Marveen Agentic Operating System

A Marveen projekt agentic OS direktívájának skill-csomagja. Minden nem triviális feladatot ezen elvek szerint kezelek. A cél: maximum completed verified tasks / cloud token consumption / time / human intervention.

## Mikor használd

- Új TASK indul (minden TASK-XXXX-hez)
- TASK dekompozíció (GOAL → EPIC → FEATURE → TASK → ACTION)
- Állapot váltás (NEW → READY → RUNNING → VERIFY → REPAIR → BLOCKED → DONE)
- Model routing döntés (LEVEL 0 / 1 / 2 / 3)
- Context gate (cloud modell hívása előtt)
- Quality gate (verify → reviewer → PASS/REWORK)
- Retry policy (max 2 autonóm repair)
- Persistent state (PROJECT_MEMORY, CURRENT_STATE, ADR)
- Failure blocker (structured formátum)
- Approval gate (high-risk / irreversible művelet)

## Hierarchikus dekompozíció

```
GOAL
 ↓
EPIC
 ↓
FEATURE
 ↓
TASK
 ↓
ACTION
```

TASK mérete: 1 cél, mérhető acceptance criteria, korlátozott rendszer-részlet, önállóan tesztelhető, önállóan checkpointolható, persisted state-ből folytatható. **"Small batch flow"** -- preferáld a sok kis TASK-ot, ne egy nagyot.

## State machine

```
NEW → READY → RUNNING → VERIFY → DONE             (normál flow)
        ↑           ↓
        └─── REPAIR (max 2) ──→ VERIFY
                    ↓
                BLOCKED (human approval)
```

DONE csak verifikált + checkpointolt állapotban. BLOCKED csak autonóm repair limit (2) után.

## Definition of Ready (DoR)

Egy TASK csak akkor mehet READY-be, ha mind megvan:
- `goal_defined` -- mi a cél
- `acceptance_criteria_defined` -- mérhető, specifikus
- `scope_understood` -- mit érint a rendszerben
- `dependencies_known` -- milyen más TASK-okra van szükség
- `required_context_available` -- van-e elég info a végrehajtáshoz
- `risk_classified` -- low / medium / high

Ne blokkolj minor implementation uncertainty miatt -- oldd meg a repo / docs / memória / lokális modellek segítségével.

## Definition of Done (DoD)

Egy TASK csak akkor DONE, ha mind megvan:
- `implementation_completed`
- `acceptance_criteria_satisfied`
- `tests_executed` + `failed_tests_investigated`
- `diff_inspected` + `unrelated_modifications_checked`
- `persistent_task_state_updated`
- `architecture_decisions_updated` (ha kell)
- `continuation_state_updated`
- `checkpoint_created`

DONE soha nem "kész a kód", hanem "kész + tesztelt + checkpointolt + memóriában".

## Standard execution workflow

```
UNDERSTAND
  ↓
SEARCH (deterministic tools)
  ↓
RETRIEVE MINIMUM CONTEXT (vector + Qwen filter)
  ↓
PLAN (rövid -- ha van érvényes terv, végrehajtok)
  ↓
IMPLEMENT
  ↓
VERIFY (tests, acceptance)
  ↓
REVIEW (diff + reviewer model)
  ↓
CHECKPOINT (Git / file)
  ↓
UPDATE MEMORY (PROJECT_MEMORY / daily-log)
  ↓
COMPACT STATE (CURRENT_STATE.yaml)
  ↓
RELEASE CONTEXT
  ↓
NEXT TASK
```

## Context Gate

A cloud modell CSAK a minimálisan szükséges kontextust kapja:

```
TASK
 ↓
DETERMINISTIC SEARCH (rg, grep, git, jq, curl)
 ↓
VECTOR RETRIEVAL (memory + relevant snippets)
 ↓
LOCAL QWEN RELEVANCE FILTER (qwen2.5:3b a HA NUC-on)
 ↓
MINIMUM REQUIRED CONTEXT
 ↓
CLOUD MODEL
```

**NE küldj**: full conversation history, complete repository, giant logs, unrelated memory, entire documentation collections.

**Potenciális inputok**: active task, acceptance criteria, current state, relevant source snippets, relevant ADRs, relevant task history, Git diff, test failures, selected logs.

## Model routing

A legalacsonyabb költségű képes szintet választom. LEVEL 3 SOHA nem default.

| LEVEL | Eszköz | Példa |
|-------|--------|-------|
| 0 | deterministic tool | rg, grep, git, jq, curl, systemctl, journalctl |
| 1 | local Qwen (qwen2.5:3b) | classification, summarization, retrieval filter, relevance ranking |
| 2 | cloud coding (claude-sonnet-4-6) | normál implementáció, mérsékelt debugging |
| 3 | strong reasoning (claude-opus-4-6) | komplex architektúra, nehezen megoldható race condition |

## Token policy

**Cél**: `completed verified tasks / cloud token consumption`. NE a rövid válaszra, hanem a teljes workflow-ra optimalizálj.

8 kötelező tiltás:
1. Ne olvass teljes repo-t, csak ha tényleg kell
2. Ne olvass újra nagy fájlokat, amik nem változtak
3. Ne tartsd a teljes beszélgetést "kényelemből"
5. Ne küldj teljes logot, ha targeted error info elég
4. Ne használj LLM-et, ha determinisztikus eszköz megoldja
6. Ne retry végtelenül -- max 2 repair
7. Ne indíts párhuzamos coding agenteket default
8. Ne kérdezd újra a tervet, ha van érvényes

## Task budget

| Class | Default execution |
|-------|-------------------|
| TRIVIAL | deterministic/local |
| SMALL | local + 1 fókuszált cloud hívás |
| MEDIUM | kontrollált cloud coding |
| COMPLEX | planner/escalation, context-minimalizálás kötelező |

Operating principles, nem rigid token-számok. Mért adatokból javítandó.

## Retry policy

**Max 2 autonóm repair.** Aztán failure report + escalate/block.

Failure report kötelező mezői:
- `task`, `error`, `evidence`, `attempted_actions`, `results`, `current_hypothesis`, `recommended_next_step`, `required_context`, `human_input_required`

**NE** ismételjem ugyanazt a megoldást kis variációkkal.

## Quality Gate

```
IMPLEMENT
 ↓
STATIC / SYNTAX CHECK
 ↓
TEST
 ↓
DIFF REVIEW
 ↓
ACCEPTANCE REVIEW
 ↓
DONE
```

Reviewer model CSAK ezt kapja: `task` + `acceptance_criteria` + `relevant_test_results` + `architecture_constraints`. Reviewer output: `PASS` vagy `REWORK` + konkrét bizonyíték.

Minőség a folyamatból jön, nem a modell magabiztosságából.

## Persistent state

- **`PROJECT_MEMORY.md`** -- tartós projekt tudás: architektúra, konvenciók, operating assumptions, infrastructure, interfaces, constraints, lessons. NEM krónológiai tevékenység-napló. Tartsd kompaktnak. Elavultat kivezetem.
- **`CURRENT_STATE.yaml`** -- új agent context innen folytat. Mezők: `active_task`, `status`, `completed`, `files_modified`, `verification` (passed/failed), `current_failure`, `next_action`, `context_required`. Tartsd tömören.
- **`decisions/ADR-XXXX.md`** -- fontos technikai döntések: `Decision` / `Reason` / `Consequences` / `Status: Active`. Architektúra-kérdés újratárgyalása előtt mindig nézd meg.
- **`tasks/TASK-XXXX.yaml`** -- TASK rekordok (séma: TASK_SCHEMA.yaml).

## Self-improvement (PDCA)

```
PLAN   -- azonosítsd a mért inefficacy-t
DO     -- alkalmazz egy kis kontrollált folyamat-változtatást
CHECK  -- hasonlítsd össze a metrikákat
ACT    -- tartsd meg, módosítsd vagy vond vissza
```

Valid target: retrieval precision, task sizing, model routing, retry rate, test reliability, context size, cloud call count. NE csak token-fogyasztást optimalizálj, ha a minőség romlik.

## Metrics + KPIs

Task-szintű rekord: `task_id`, `complexity`, `result`, `llm_calls`, `local_model_calls`, `cloud_model_calls`, `strong_model_calls`, `repair_attempts`, `files_read`, `files_modified`, `tests_passed`, `tests_failed`, `first_pass_success`, `lead_time`.

Fő KPI:
- **Cloud calls / DONE task**
- **Repair attempts / DONE task**
- **First Pass Yield** = first-verify pass / all verified
- **Task lead time**
- **Blocked task rate**

Fő hatékonysági metrika: `verified DONE output / external AI consumption`.

## Anti-patterns (NE csináld)

1. full repository reads by default
2. unlimited retries
3. full conversation memory
4. automatic research for every task
5. parallel agents by default
6. verbose repeated planning
7. massive raw tool outputs
8. entire-file rewrites when patches suffice
9. strongest model for every request
10. agent-to-agent conversation without clear value

Minden extra modell-hívásnak legyen defined purpose.

## Failure behavior

Structured blocker:
```
status: BLOCKED
task: TASK-XXXX
completed: [...]
blocking_issue: ...
evidence: ...
attempts: ...
recommended_next_step: ...
human_input_required: true|false
```

`human_input_required = false` ha más modell/eszköz megoldhatja. Csak valóban szükséges user beavatkozásnál `true`.

## Communication

- **Outcome-focused**: `TASK-XXXX completed. Tests: x/y. Queue: n. Next: TASK-XXXX.`
- **Blocker-nél**: `TASK-XXXX blocked. Cause: ... Impact: ... Recommended action: ...`
- **Approval formátum**: `proposed action / reason / risk / rollback possibility / recommended decision` -- és várj jóváhagyásra.
- **NE** öntsd a belső reasoninget vagy raw logokat, csak ha kérdezik.

## Buktatók

- A meglévő rendszert (kanban, store/, src/, globális skill-ek) **NE írd felül, csak EXTEND-áld**.
- TASK-XXXX prefix a kanban `title` mezőben (pl. `"TASK-0001: ..."`), ne a kanban rendszert írd újra.
- Lokális skill a projekt `skills/` mappájába (a `seed-skills/` konvenciót követve), **NEM** a globális `~/.claude/skills/`-be.
- Persistent state a projekt gyökerében (vagy `marveen/` almappában), **NEM** a `~/.openclaw/workspace/` alá.
- **WIP = 1**: ne ugrálj több TASK között párhuzamosan.
- Ha a direktíva ellentmond a meglévő rendszernek, a meglévő rendszerhez igazítsd a bevezetést.
- A kanban rendszer TITLE-jébe írd a TASK-XXXX prefixet, ne a kanban DB-t módosítsd (a kanban ID marad hex).
- A lokális Qwen a HA NUC Ollama-n fut (`OLLAMA_URL=http://192.168.1.53:11434`, modell `qwen2.5:3b`). NE a Marveen host saját Ollama-ján (ott csak embedding modellek vannak).
- A cloud model a MiniMax proxy-n át (`ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic`), modell `claude-opus-4-6`. A HA NUC nem elérhető SSH-n (22 zárva), csak az Ollama API (11434) él.

## Ellenőrzés

Minden TASK után:
- `TASK-XXXX.yaml` rekord létezik a `tasks/` mappában
- `CURRENT_STATE.yaml` frissül, ha TASK DONE vagy BLOCKED
- `decisions/ADR-XXXX.md` új fontos döntésnél
- `PROJECT_MEMORY.md` frissül, ha új tartós tudás van
- Verifikáció (test + diff + acceptance review) minden DONE előtt
- Checkpoint (Git commit ha van változás) minden sikeres TASK után
- Napi napló a fontosabb eseményekről