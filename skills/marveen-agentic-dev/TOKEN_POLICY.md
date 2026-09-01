---
name: marveen-agentic-dev-token
description: Token policy. Cél: completed verified tasks / cloud token consumption. 8 kötelező tiltás + preferenciák + Context Gate integráció + metrikák.
---

# Token Policy

## Cél

```
completed verified tasks
------------------------
cloud token consumption
```

NE a rövid válaszra, hanem a TELJES WORKFLOW optimalizálására. A sikeres TASK-ok száma osztva a cloud token fogyasztással -- ez a fő hatékonysági metrika.

## 8 Kötelező tiltás

1. **Ne olvass teljes repo-t**, csak ha tényleg szükséges. `rg` / `grep` / `find` először, `Read` csak a szűrt találatokra.
2. **Ne olvass újra nagy fájlokat**, amik nem változtak. A már beolvasott + nem módosult fájlokat ne húzd be újra a context-be.
3. **Ne tartsd meg a teljes beszélgetést** "kényelemből". A perzisztens state a fájlrendszerben van (TASK-XXXX.yaml, CURRENT_STATE.yaml, memória), nem a context-ben.
4. **Ne küldj teljes logot** a cloud modellnek. Csak a releváns hibasort + a környező contextet.
5. **Ne használj LLM-et**, ha determinisztikus eszköz megoldja. `rg`, `git`, `jq`, `curl`, `systemctl`, `journalctl` elsőbbséget kapnak.
6. **Ne retry végtelenül**. Max 2 autonóm repair, aztán BLOCKED + structured failure report.
7. **Ne indíts párhuzamos coding agenteket** default. WIP=1, kivéve HA a direktíva explicit engedi.
8. **Ne kérdezd újra a tervet**, ha van érvényes. Replan CSAK ha evidencia érvényteleníti a tervet.

## Preferenciák (preferáld ezeket)

- **search**: `rg`, `grep`, `git log --oneline`, `git diff`
- **retrieval**: vector memory + snippet, NEM teljes dokumentum
- **targeted file sections**: csak a releváns rész, NEM az egész fájl
- **diffs**: `git diff` a módosításokról, NEM before/after dumps
- **structured summaries**: TASK-XXXX.yaml, ADR-XXXX.md formátumban
- **persistent state**: fájlrendszer + SQLite, NEM context
- **deterministic verification**: tesztek + acceptance review, NEM "magabiztosság"
- **compact escalation packages**: ha nem boldogulok, `escalate: true` + `reason` + `recommended_role` + `required_context` + `evidence`, NEM hosszú leírás

## Context Gate integráció

A Context Gate a Token Policy egyenes következménye:

```
TASK
 ↓
DETERMINISTIC SEARCH (rg, git, jq, curl)        ← 8/1 tiltás alatt
 ↓
VECTOR RETRIEVAL (memory)                        ← preferenciák: retrieval
 ↓
LOCAL QWEN RELEVANCE FILTER (qwen2.5:3b)         ← preferenciák: local before cloud
 ↓
MINIMUM REQUIRED CONTEXT (~ 500-2000 token)      ← 8/3 tiltás alatt
 ↓
CLOUD MODEL
```

A cloud modell CSAK a minimum required contextet kapja. NE a teljes beszélgetést, NE a teljes repo-t, NE a giant logot, NE az unrelated memoryt.

## Metrikák

A token policy sikerességét ezekkel a metrikákkal mérjük:

- **Cloud calls / DONE task**: hány cloud hívás kell egy sikeres TASK-hoz
- **Context size átlag**: hány token a cloud modell inputja
- **Local Qwen hívások aránya**: classification/summarization/filter qwen2.5:3b-vel vs cloud
- **Repair rate**: hány TASK megy REPAIR-be
- **First Pass Yield**: first-verify pass / all verified

## Anti-patterns (NE csináld)

- Full conversation history in the cloud prompt
- Reading the entire repo to "understand context"
- Sending giant logs (filter first)
- Multiple parallel agents by default
- Re-explaining the plan repeatedly
- Asking the cloud model to do work that `rg`/`git`/`jq` can do
- Calling LEVEL 3 (Opus) for every request

## Ellenőrzés

Minden TASK után:
- `metrics.cloud_model_calls` <= 5 (TRIVIAL), <= 10 (SMALL), <= 20 (MEDIUM), <= 50 (COMPLEX)
- `metrics.first_pass_success` true (ha elérhető)
- A cloud prompt mérete <= 3000 token (TRIVIAL/SMALL), <= 8000 (MEDIUM/COMPLEX)

## Buktatók

- Ha a cloud prompt > 8000 token, valószínűleg nem alkalmaztad a Context Gate-et -- térj vissza a SEARCH + RETRIEVE MIN lépésekre
- Ha `metrics.repair_attempts` > 2, a root cause analysis nem volt elég mély -- bontsd TASK-okra
- Ha `metrics.first_pass_success` false az esetek > 30%-ában, a Definition of Ready (acceptance criteria) nem elég specifikus