---
name: marveen-agentic-dev-quality
description: Quality policy. Quality gate (IMPLEMENT → STATIC → TEST → DIFF REVIEW → ACCEPTANCE REVIEW → DONE), reviewer input/output formátum, Definition of Done checklist.
---

# Quality Policy

## Alapelv

**A minőség a folyamatból jön, nem a modell magabiztosságából.**

Egy implementation "úgy tűnik, működik" NEM quality. Quality = implementáció + acceptance + tests + diff review + acceptance review, mind átment.

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

Minden lépést dokumentálni kell a TASK-XXXX.yaml `execution.verification` mezőjében.

### 1. STATIC / SYNTAX CHECK

- TypeScript: `npm run typecheck`
- JavaScript: `node --check` vagy eslint
- Python: `python -m py_compile` + ruff/mypy
- Bash: `bash -n`

Ha a syntax check elbukik, a TASK nem megy tovább a TEST-be -- javítás + újra STATIC.

### 2. TEST

- Unit tesztek: a módosított modul/unit tesztjei
- Integration tesztek: ha van rá dependency (DB, hálózat, külső API)
- Manual smoke test: ha az acceptance criteria-ban van ilyen lépés

A teszt-eredményeket a `TASK-XXXX.yaml` `execution.verification` mezőben rögzítsd (passed/failed counts).

### 3. DIFF REVIEW

- `git diff` a módosításokról
- Ellenőrizd: csak a TASK-hoz tartozó változások, NEM unrelated módosítások
- Ellenőrizd: a kód-stílus konzisztens (lásd PROJECT_MEMORY.md)
- Ellenőrizd: nincs dead code, nincs commented-out kód, nincs debug print
- Ellenőrizd: nincs unused import / variable

### 4. ACCEPTANCE REVIEW

- Minden acceptance criteria teljesül?
- A reviewer model CSAK ezt kapja:
  - `task` (TASK-XXXX + goal)
  - `acceptance_criteria` (lista)
  - `relevant_diff` (a TASK-hoz tartozó `git diff`)
  - `relevant_test_results` (passed/failed + details)
  - `architecture_constraints` (releváns ADR-ek, konvenciók)
- Reviewer output: `PASS` vagy `REWORK` + konkrét bizonyíték (mely sor, mely kritérium, miért)

Ha `REWORK`: REPAIR állapot, max 2 javítási kísérlet.

### 5. DONE

- Csak az 1-4 lépések MIND átmentek után
- TASK-XXXX.yaml: `status: done`, `updated_at`, `result`, `metrics`
- CHECKPOINT (git commit + state update)

## Reviewer Model input/output formátum

### Input (a reviewer kapja)

```
TASK: TASK-XXXX
ACCEPTANCE_CRITERIA:
  - criterion 1
  - criterion 2
  - ...
DIFF:
  ... (git diff kimenet, csak a releváns rész) ...
TEST_RESULTS:
  passed: N
  failed: N
  details:
    - test_name: status
ARCHITECTURE_CONSTRAINTS:
  - ADR-XXXX (releváns)
  - PROJECT_MEMORY.md "Coding conventions"
```

### Output (a reviewer adja)

```
VERDICT: PASS | REWORK
EVIDENCE:
  - criterion 1: satisfied (where in diff)
  - criterion 2: not satisfied (line N: reason)
  - ...
```

### Mit NE kapjon a reviewer

- A teljes repo-t
- A teljes beszélgetést
- A teljes TASK history-t
- Unrelated contextet
- A módosítatlanul hagyott fájlokat

A reviewer CSAK a fenti 5 mezőre reagáljon. NE hozzon létre új tervet, NE javasoljon új funkciókat, NE foglalkozzon unrelated dolgokkal.

## Definition of Done checklist

Minden TASK-nál ellenőrizni kell a TASK-XXXX.yaml `definition_of_done` szekciójában:

- [ ] `implementation_completed`
- [ ] `acceptance_criteria_satisfied`
- [ ] `tests_executed`
- [ ] `failed_tests_investigated` (ha volt failure)
- [ ] `diff_inspected`
- [ ] `unrelated_modifications_checked`
- [ ] `persistent_task_state_updated`
- [ ] `architecture_decisions_updated` (ha új döntés született)
- [ ] `continuation_state_updated` (CURRENT_STATE.yaml frissítve)
- [ ] `checkpoint_created` (git commit megtörtént)

Ha bármelyik hiányzik, a TASK NEM DONE -- maradjon REPAIR vagy BLOCKED.

## Anti-patterns (NE csináld)

- "Elkészült a kód, biztos jó lesz" -- NEM quality, csak magabiztosság
- Tesztek kihagyása "kicsi a változás" -- minden változásnak van acceptance criteria
- Reviewer modellek teljes context-tel való ellátása -- csak a releváns input
- Acceptance criteria "majd később pontosítjuk" -- a TASK csak DoR-rel együtt indul
- "Passzol a teszt, kész" -- a teszt az EGYIK lépés, NEM az egész quality gate
- STATIC check kihagyása "gyors lesz" -- a syntax errorok downstream hibákat okoznak

## Ellenőrzés

Minden TASK után:
- `execution.verification.passed` >= az acceptance criteria-k száma
- `metrics.first_pass_success` true (ha sikeres volt az első verify)
- Definition of Done minden eleme true
- Reviewer verdict PASS (vagy REWORK + repair ciklus rögzítve)
- A git commit csak a TASK-hoz tartozó fájlokat tartalmazza

## Buktatók

- Reviewer modellek `claude-opus-4-6`-al való hívása, amikor `qwen2.5:3b` is elég lenne a review-hoz (klassz kis review, diff rövid)
- Reviewer input > 5000 token -- túl sok context; szűrj a diff-ből és a test results-ból
- "Self-review" elfogadása reviewer nélkül -- ha a TASK COMPLEX vagy új funkciót vezet be, MINDIG reviewer model kell
- Acceptance criteria átfogalmazát RETROACTÍVAN, hogy a kód átmenjen -- az acceptance criteria a DoR része, NEM utólag igazítjuk