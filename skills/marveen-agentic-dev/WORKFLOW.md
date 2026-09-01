---
name: marveen-agentic-dev-workflow
description: Standard execution workflow reference. A SKILL.md rövid összefoglalójából a WORKFLOW részletes kibontva: UNDERSTAND → SEARCH → RETRIEVE MIN → PLAN → IMPLEMENT → VERIFY → REVIEW → CHECKPOINT → UPDATE MEMORY → COMPACT → RELEASE → NEXT. Minden TASK ezen megy végig, sorrendben.
---

# Standard Execution Workflow

A Marveen Agentic OS 12-lépéses végrehajtási workflow-ja. Minden TASK ezen megy végig, sorrendben, lépésenként. A SKILL.md a rövid összefoglalót adja, ez a fájl a részletes referenciát.

A 12 lépés ciklikus: minden TASK végigmegy rajta, és a 12. lépés a következő TASK 1. lépése.

---

## 1. UNDERSTAND

**Cél**: a TASK valódi megértése, félreértések kiszűrése.

Bemenet: TASK-XXXX.yaml (goal, acceptance_criteria, scope, dependencies, risk).

Output: confirmed understanding + open kérdések listája (ha van).

Lépések:
- Olvasd el a TASK-XXXX.yaml-t (a saját rekord a `tasks/` mappában)
- Azonosítsd a goal-t és az acceptance criteria-kat
- Ellenőrizd a scope-ot -- mi a rendszer érintett része?
- Ha bármi homályos, keress a memóriában + a repo-ban (`rg`, `grep`, NEM teljes olvasás)
- Ha a homály MATERIALLY befolyásolja az üzleti eredményt, kérdezz rá Alex-t (NE implementation question-t -- azt oldd meg magad a repo + docs + memory + local Qwen segítségével)

Buktató:
- NE kezdj el implementálni anélkül, hogy értenéd, MIT kell tenni
- NE olvasd be az egész repo-t csak hogy "értsd a kontextust"

---

## 2. SEARCH

**Cél**: a releváns kontextus megtalálása determinisztikus eszközökkel, MIELŐTT bármit olvasnál.

Lépések (sorrendben, a legolcsóbbtól a legdrágábbig):
1. `rg` / `grep` a kulcsszavakra a repo-ban
2. `git log` / `git diff` a kapcsolódó commit-okra / módosításokra
3. `find` a fájl-struktúra feltérképezéséhez
4. Memory API (vector retrieval) a korábbi tanulságokért
5. ADR-ek (`decisions/ADR-XXXX.md`) a vonatkozó architektúra-döntésekért
6. Csak a szűrt találatokat olvasd (`READ`), NEM az egész fájlt ha nem kell

Output: lista a releváns fájlokról + snippetekről + ADR-ekről.

Buktató:
- NE olvass teljes repo-t default
- NE használj LLM-et, ha `rg`/`grep` megoldja
- Csak a MINIMUM szükséges fájlokat olvasd

---

## 3. RETRIEVE MINIMUM CONTEXT

**Cél**: a cloud modell számára a MINIMUM szükséges kontextus összeállítása (Context Gate).

Lépések:
1. Determinisztikus search eredményei (snippetek, NEM teljes fájlok)
2. Vector retrieval a memóriából (top-K releváns bejegyzések)
3. **Local Qwen relevance filter** (`qwen2.5:3b` a HA NUC-on): kiszűri a nem releváns találatokat a cloud modell helyett
4. Összeállítás a Context Gate-be:
   - aktív TASK (goal + acceptance criteria)
   - current state (CURRENT_STATE.yaml)
   - relevant source snippets (5-20 darab, ~ 500-2000 token)
   - relevant ADRs
   - Git diff (ha van)
   - test failures (ha vannak)

Output: minimum context package (~ 500-2000 token, NEM 50K).

Buktató:
- NE küldj teljes beszélgetést
- NE küldj teljes repo-t
- NE küldj giant logokat (csak a releváns hibasort)
- Csak a NEXT DECISION-höz szükséges info

---

## 4. PLAN

**Cél**: rövid, konkrét végrehajtási terv.

Output: 3-7 lépéses terv, ami:
- Az acceptance criteria-kat konkrét implementációs lépésekre bontja
- Megadja a módosítandó fájlokat (konkrét útvonalak)
- Azonosítja a teszteket, amiket futtatni kell
- Megadja a verification módját (mely tesztek, milyen output)

Buktató:
- NE tervezz 10+ lépésben -- ha túl nagy, bontsd TASK-okra
- Ha van ÉRVÉNYES terv, NE replanj újra ("Ne ess pánikba" + "Ne kérdezd újra a tervet")
- Replan CSAK ha evidencia érvényteleníti a tervet (új info, hiba, scope-változás)
- A tervezés NE legyen hosszabb, mint a végrehajtás -- ha igen, túltervezel

---

## 5. IMPLEMENT

**Cél**: a terv végrehajtása, minimális módosításokkal.

Lépések:
1. Read a cél fájlokat (ha még nem olvastad a 2. lépésben)
2. Edit/Write a módosításokat -- **PATCH, ne teljes fájl újraírás, ha lehet**
3. Minden módosítás után szintaxis-ellenőrzés (`npm run typecheck`, `syntax-check`, stb.)
4. A working tree-t tisztán tartva (NE módosíts unrelated file-okat)

Output: módosított fájlok + lokális szintaxis-ellenőrzés eredménye.

Buktató:
- NE írj át teljes fájlokat, ha patch elég
- Minden módosítás után szintaxis-ellenőrzés
- Tartsd a kód-stílust (lásd `PROJECT_MEMORY.md` "Coding conventions" szekció)
- NE vegyítsd a TASK-ot unrelated módosításokkal

---

## 6. VERIFY

**Cél**: a TASK acceptance criteria-jainak ÉS a teszteknek az ellenőrzése.

Lépések:
1. Futtasd a célzott teszteket (`npm test`, `pytest`, `vitest run`, stb.)
2. Ellenőrizd az acceptance criteria-kat egyenként (mindegyik teljesül?)
3. Ha bármi elbukott, rögzítsd (`current_failure` mező a TASK-XXXX.yaml-ban: test, error, stack)
4. Ha minden átment, menj a REVIEW-ba (7. lépés)

Output: passed/failed counts + failure details.

Buktató:
- NE jelentd késznek, ha bármely acceptance criteria nem teljesül
- NE ignoráld a failed teszteket ("majd később megjavítom")
- Ha a teszt nem determinisztikus (flaky), rögzítsd a TASK-ban és térj vissza rá

---

## 7. REVIEW

**Cél**: egy másik modell (vagy te magad "reviewer mode"-ban) átnézi a diff-et + az acceptance criteria-kat.

Lépések:
1. `git diff` a módosításokról (CSAK a TASK-hoz tartozó)
2. Reviewer input: `TASK` + `acceptance_criteria` + `relevant_diff` + `relevant_test_results` + `architecture_constraints`
3. Reviewer output: `PASS` vagy `REWORK` + konkrét bizonyíték (mely sor, mely kritérium, miért)
4. Ha `PASS`: menj a CHECKPOINT-ba (8. lépés)
5. Ha `REWORK`: REPAIR állapot, vissza az IMPLEMENT-be (5. lépés), max 2 repair kísérlet

Output: PASS / REWORK döntés + indoklás.

Buktató:
- Reviewer NE kapja meg a teljes repo-t
- Reviewer NE hozzon létre új tervet -- CSAK a diff-re reagáljon
- Ha a review szubjektív ("ez nem tetszik"), kérdezd meg Alex-t (Approval Gate)

---

## 8. CHECKPOINT

**Cél**: a sikeres TASK állapotának perzisztálása.

Lépések:
1. TASK-XXXX.yaml frissítése: `status: done`, `updated_at`, `result`, `metrics`, `next_action`
2. Git commit -- CSAK a TASK-hoz tartozó új/módosított fájlokat
3. Ha a TASK új tartós tudást hozott létre, frissítsd a `PROJECT_MEMORY.md`-t
4. Ha új architektúra-döntés született, hozz létre `decisions/ADR-XXXX.md`-t
5. Ha bármi meglepő / tanulságos történt, frissítsd a memóriát + napi naplót

Output: TASK done a git history-ban + perzisztens state naprakész.

Buktató:
- NE commitolj unrelated módosításokat (amik a TASK előtt is a working tree-ben voltak)
- Ha a commit destruktív (pl. adat-törlés, token-változtatás), kérj approval-t Alex-től a 25. szekció szerint
- Commit message: TASK-XXXX + rövid leírás, pl. `TASK-0003: skills/marveen-agentic-dev/ SKILL.md + TASK_SCHEMA.yaml`

---

## 9. UPDATE MEMORY

**Cél**: a tanulságok perzisztálása a memóriában.

Lépések:
1. Ha a TASK új tanulságot hozott (pl. "ne használj X-et, mert Y"), frissítsd a memóriát (`warm` tier ha ritkán változik, `cold` ha tartós tanulság)
2. Ha a TASK új konvenciót hozott, frissítsd a `PROJECT_MEMORY.md`-t
3. Napi napló (`/api/daily-log`): rövid összegzés a naplóban (dátum + TASK-XXXX + outcome)

Output: memória + napi napló + PROJECT_MEMORY.md naprakész.

Buktató:
- NE tárolj minden részletet -- csak a TARTÓS tudást
- A `PROJECT_MEMORY.md`-t tartsd TÖMÖREN (max ~ 200 sor); ha hosszabb, szét kell bontani
- A napi napló legyen rövid, ne legyen kronológiai napló (az a `daily-log` API-ban van, nem a memóriában)

---

## 10. COMPACT STATE

**Cél**: a `CURRENT_STATE.yaml` frissítése a resume-from-context-hez.

Lépések:
1. Frissítsd a `CURRENT_STATE.yaml` mezőit:
   - `active_task`: TASK-XXXX (ha van aktív)
   - `status`: NEW / READY / RUNNING / VERIFY / REPAIR / BLOCKED / DONE
   - `completed`: az elkészült lépések listája
   - `files_modified`: relatív útvonalak
   - `verification`: passed/failed counts
   - `current_failure`: ha van (test, error, stack)
   - `next_action`: one-line, resumable
   - `context_required`: minimum required context sources (TASK-XXXX.yaml, src/... fájl, ADR-XXXX.md)
2. Tartsd TÖMÖREN (max ~ 50 sor)

Output: `CURRENT_STATE.yaml` naprakész, új agent context innen folytathatja a munkát teljes beszélgetés nélkül.

Buktató:
- NE legyen túl hosszú (a kompaktság a lényeg)
- Csak a RESUME-hoz szükséges info
- NE másold a teljes TASK-XXXX.yaml-t -- elég a `context_required` lista

---

## 11. RELEASE CONTEXT

**Cél**: az LLM context felszabadítása a következő TASK-hoz.

Lépések:
1. Ellenőrizd, hogy minden perzisztens state a fájlrendszerben van:
   - TASK-XXXX.yaml (state + metrics)
   - CURRENT_STATE.yaml (resume-from-context)
   - PROJECT_MEMORY.md (tartós tudás)
   - decisions/ADR-XXXX.md (döntések)
   - memória API (tanulságok)
   - napi napló (események)
   - git history (checkpoint)
2. Az LLM context-ből töröld a felesleges részleteket:
   - NE tartsd meg a teljes beszélgetést
   - NE tartsd meg a teljes TASK-végrehajtás minden tool-outputját
   - Csak a CURRENT_STATE.yaml + a következő TASK acceptance criteria-ja maradjon
3. Készülj fel a következő TASK-ra (READY állapot)

Output: tiszta LLM context + perzisztens state a fájlrendszerben.

Buktató:
- NE tartsd meg a teljes beszélgetést "biztonság kedvéért"
- A perzisztens state a FÁJLRENDSZERBEN van, nem a context-ben
- Ha a session-restart megtörténik, a CURRENT_STATE.yaml + TASK-XXXX.yaml elég a folytatáshoz

---

## 12. NEXT TASK

**Cél**: a következő TASK indítása a queue-ból.

Lépések:
1. Olvasd a `CURRENT_STATE.yaml`-t + a kanban-t (`/api/kanban`)
2. Válaszd ki a következő READY TASK-ot a sorrend figyelembevételével:
   1. **blockers** (feloldandó blokkok előbb)
   2. **dependencies** (amire szükség van, az előbb)
   3. **priority** (urgent > high > normal > low)
   4. **readiness** (DoR checklist teljesül)
3. Ha nincs READY TASK: várakozás (idle), vagy új TASK dekompozíció ha a user adott új inputot
4. Indítsd el az új TASK-ot: az 1. lépés (UNDERSTAND) újraindul

Output: új TASK RUNNING állapotban.

Buktató:
- NE indíts több TASK-ot PÁRHUZAMOSAN (WIP=1, kivéve HA a direktíva explicit engedi)
- NE ugrálj a TASK-ok között (current TASK befejezése előtt ne kezdj újat)
- Ha az új TASK-hoz újabb dekompozíció kell, csináld meg (GOAL → EPIC → FEATURE → TASK)

---

## Összefoglaló

A 12 lépés ciklikus, és minden TASK végigmegy rajta:

```
UNDERSTAND → SEARCH → RETRIEVE MIN → PLAN → IMPLEMENT → VERIFY → REVIEW → CHECKPOINT → UPDATE MEMORY → COMPACT → RELEASE → NEXT
                                                                                                                  ↓
                                                                                                            (új TASK)
```

**Small batch flow**: minden lépés a lehető legkisebb scope-ot célozza. Ha bármelyik lépés túl nagynak tűnik, bontsd TASK-okra.

**Stop and escalate**: ha bármelyik lépésben 2 repair kísérlet kudarcot vall (VERIFY → REPAIR → VERIFY → REPAIR), NE folytasd -- blokkolj + escalate (BLOCKED + structured blocker).

**Verification instead of confidence**: a DONE állapot CSAK verifikált + checkpointolt állapot. A "kész a kód, még nem teszteltem" NEM DONE.

**Persistent state instead of persistent conversation**: minden perzisztens adat a fájlrendszerben. Az LLM context bármikor felszabadítható.

**Search before read**: `rg`/`grep`/`git`/`jq`/`curl`/`systemctl`/`journalctl` elsőbbséget kapnak az LLM-mel szemben.

**Local Qwen before cloud**: classification, summarization, retrieval filter, relevance ranking -- NE küldd a cloud modellnek, ha qwen2.5:3b megoldja a HA NUC-on.