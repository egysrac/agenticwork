---
name: marveen-agentic-dev-failure
description: Failure policy. Max 2 autonóm repair, failure report kötelező mezők, structured blocker formátum, anti-patterns, escalation formátum.
---

# Failure Policy

## Alapelv

**Max 2 autonóm repair.** Aztán NE folytass -- blokkolj + escalate.

A spekulatív végtelen javítás pazarlás. Ha 2 repair kísérlet kudarcot vall, az evidencia: a probléma más eszközt / modellt / kontextust / humán beavatkozást igényel.

## Workflow

```
FAIL
 ↓
ROOT CAUSE ANALYSIS
 ↓
REPAIR 1
 ↓
VERIFY
 ↓ (ha failed)
ROOT CAUSE UPDATE
 ↓
REPAIR 2
 ↓
VERIFY
 ↓ (ha failed)
STOP REPETITIVE REPAIR
 ↓
CREATE FAILURE REPORT
 ↓
ESCALATE or BLOCK
```

A REPAIR 1 és REPAIR 2 **különböző megközelítés** kell legyen, nem ugyanannak a megoldásnak kis variációi.

## Failure Report (kötelező mezők)

Minden escalation előtt kötelező failure report:

```
task: TASK-XXXX
error: ...
evidence: ...
attempted_actions:
  - REPAIR 1: ...
  - REPAIR 2: ...
results:
  - REPAIR 1: failed (reason: ...)
  - REPAIR 2: failed (reason: ...)
current_hypothesis: ...
recommended_next_step: ...
required_context:
  - ...
human_input_required: true|false
```

Ha `human_input_required: true`, küldd el Alex-nek az approval formátumban (proposed action / reason / risk / rollback / recommended decision).

Ha `human_input_required: false`, escalate más modellhez / eszközhöz (pl. cloud Opus ha local Qwen nem volt elég, vagy más dependency / kontextus).

## Structured Blocker formátum

Amikor a TASK-XXXX BLOCKED állapotba kerül:

```
status: BLOCKED
task: TASK-XXXX
completed: [...]
blocking_issue: ...
evidence: ...
attempts: 2
recommended_next_step: ...
human_input_required: true|false
```

Ez a formátum megy a `TASK-XXXX.yaml` `result` mezőjébe + a structured communication-ba Alex felé.

## Anti-patterns (NE csináld)

- Végtelen retry (3+ repair) -- a Retry Policy ezt tiltja
- Ugyanaz a megoldás újra meg újra (kis variációkkal) -- ha 2 repair nem segít, a megközelítés rossz
- Failure eltitkolása + további spekulatív munka -- "block instead of endlessly work"
- A user meglepése a failure-val -- a structured blocker AZONNAL menjen, ne a végén

## Root Cause Analysis

Minden REPAIR előtt kötelező root cause analysis:

1. **Mi a tényleges hiba?** (nem a tünet, hanem az ok)
2. **Miért nem vette észre a VERIFY?** (ha acceptance criteria nem volt elég specifikus)
3. **Mit lehet másképp csinálni?** (a repair akció)
4. **Mi a legkisebb változtatás, ami megoldja?** (NE overengineerelj)

Ha a root cause analysis nem tud konkrét választ adni, a TASK scope-ja túl nagy -- bontsd TASK-okra, ne erőltesd.

## Repair akció típusok

A REPAIR 1 és REPAIR 2 legyen **különböző típusú**:

| REPAIR 1 típus              | REPAIR 2 típus (különböző!)      |
|------------------------------|----------------------------------|
| Code patch                   | Configuration change             |
| Acceptance criteria refinement | Different test approach        |
| Re-implementation            | Rollback + újra                  |
| Local fix                    | Dependency upgrade               |
| Implementation               | Documentation/spec fix           |
| Refactor                     | Teljes újraírás (csak ha kell)   |

Ugyanaz a kategória kis variációkkal = nem repair, hanem "reménykedés".

## Kommunikáció BLOCKED állapotban

Alex felé (rövid, konkrét, döntés-orientált):

- TASK-XXXX BLOCKED (2 repair kudarc)
- Cause: ...
- Impact: ...
- Recommended action: ...

NE a teljes failure report-ot küldd, csak a lényeget. A teljes report a TASK-XXXX.yaml-ban van.

## Ellenőrzés

Minden TASK után:
- Ha DONE: `metrics.repair_attempts` <= 2
- Ha BLOCKED: failure report + escalation megtörtént
- NE legyen 3+ repair attempts a metrics-ben
- Ha `repair_attempts` == 2 és BLOCKED, a structured blocker AZONNAL menjen Alex felé

## Buktatók

- "Hátha most sikerül" -- ez nem evidencia-alapú döntés, hanem reménykedés
- Repair kísérletek 10+ alkalommal -- a Retry Policy ezt tiltja, a TASK scope-ját kell csökkenteni
- Failure report Alex-nek küldése nélkül -- a kommunikáció azonnali, nem a végén