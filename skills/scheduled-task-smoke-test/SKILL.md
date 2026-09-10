---
name: scheduled-task-smoke-test
description: Mikor `~/.claude/scheduled-tasks/<name>/task-config.json` fájlt MÓDOSÍTOTTÁL (type, command, schedule, timeoutMs, failThreshold, prompt bármely mező), KÖTELEZŐ end-to-end smoke test a deploy UTÁN. A BUG-0015 (2026-09-02) tanulsága: a scripted (type:command) task `command` mező nélkül CSENDŐL hal meg 33+ órán át, és a task_run history `fired` státusza HAMIS biztonságérzetet ad. Trigger: scripted task-config szerkesztése UTÁN azonnal.
---

# Scheduled Task Smoke Test

## Mikor használd

**MINDIG**, ha a `~/.claude/scheduled-tasks/<name>/task-config.json` fájlt MÓDOSÍTOTTAD -- típustól függetlenül (`task`, `heartbeat`, `command`, `dream-engine`, stb.). Különösen kritikus `type: 'command'` esetén, mert a scripted parancs CSENDES kihagyása NEM hagy nyomot a journal-ban.

**NE használd**, ha a scripted taskot csak OLVASOD, vagy a scripted task_config `description` mezőjét (belső megjegyzés) módosítod.

## A 4-rétegű hibaláncolat, amit megelőzöl (BUG-0015, 2026-09-02)

A scripted send task 33+ órán át csendben nem futott, mert a 4 védelmi réteg EGYSZERRE HIÁNYZOTT:

| Réteg | Mi történik, ha nincs smoke test | Megelőzés |
|-------|---------------------------------|-----------|
| 1. Silent skip | `runCommandTask` (`src/web/command-task.ts:83-86`) csak WARN logot ír és return-öl, ha nincs `command` mező | Lépés 5 (health verify) |
| 2. No schema validation | A `task-config.json` módosításakor nincs JSON séma validáció | Lépés 2 (séma-validáció) |
| 3. `fired` ≠ success | A task_run history `fired` státusza a runner trigger-jét jelenti, NEM a scripted parancs sikerét | Lépés 5-6 (health + run history) |
| 4. No smoke test | A scripted task_config MÓDOSÍTÁSA UTÁN nem futtatják le run-now triggerrel | Ez a skill |

**FONTOS 5. RÉTEG (2026-09-02 07:00 felfedezés):** a `POST /api/schedules/<name>/run` endpoint (`src/web/routes/schedules.ts:227-238` → `runScheduledTaskNow` a `src/web/schedule-runner.ts:997-1027`-ben) `type:'command'` tasknál NEM a scripted parancsot futtatja, hanem az LLM trigger utat (`attemptFireTask`). A run-now trigger `result: "jarvis: fired"`-et ír, de a `runCommandTask` SOHA NEM HÍVÓDIK -- a scripted parancs nem fut le. Ezért a scripted task-config smoke tesztjénél a `command-task-health.json` frissülést a **KÖVETKEZŐ CRON TICK-ből** kell ellenőrizni (06:00-nál a scripted send task esetén), nem run-now-ból. VAGY: a `runScheduledTaskNow` függvényt JAVÍTANI kell, hogy `type === 'command'` esetén a `runCommandTask`-ot hívja.

Részletes gyökér ok: `~/.claude/projects/-home-alex-marveen/memory/project_root_cause_silent_skip_2026_09_02.md`

## Eljárás (lépésről lépésre)

### 1. Backup (a módosítás ELŐTT, KÖTELEZŐ)

```bash
TS=$(date +%Y%m%d-%H%M%S)
TASK=<TASK_NAME>  # pl. reggeli-napindito-send
cp ~/.claude/scheduled-tasks/$TASK/task-config.json \
   ~/.claude/scheduled-tasks/$TASK/task-config.json.bak-$TS
echo "Backup: ~/.claude/scheduled-tasks/$TASK/task-config.json.bak-$TS"
```

### 2. JSON séma-validáció (a módosítás UTÁN, a deploy ELŐTT)

Lásd `scripts/smoke-validate.py` -- `python3 scripts/smoke-validate.py <TASK_NAME>` futtatja a JSON séma-validációt (type mező konzisztencia a kötelező mezőkkel).

Ha FAIL: NE TELEPÍTSD. Javítsd a JSON-t, vagy rollback a backup-ra.

### 3. Deploy (a szerkesztett task-config.json élesítése)

A schedule-runner a legközelebbi 60s tick-ben (vagy service restart után) olvassa újra. Nincs külön deploy parancs -- a fájl a helyén van, a runner 60s-on belül látja.

### 4. Run-now trigger (a deploy UTÁN, KÖTELEZŐ)

```bash
TOKEN=$(cat ~/marveen/store/.dashboard-token)
TASK=<TASK_NAME>

curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/schedules/$TASK/run"
```

Várt válasz: `{"ok": true, "result": "<agent>: <outcome>"}` (pl. `jarvis: fired`). Ha `ok: false`, a scripted task NEM INDULT EL.

**KORLÁT (`type:'command'` taskoknál):** a run-now endpoint `attemptFireTask`-ot hív, nem `runCommandTask`-ot. A `fired` státusz NEM JELENTI a scripted parancs végrehajtását. A scripted task-config deploy smoke tesztjénél a `command-task-health.json` frissülést a **KÖVETKEZŐ CRON TICK-ből** kell megvárni (06:00-nál a scripted send task esetén), ÉS onnan ellenőrizni:
- Ha a scripted task `schedule: "0 6 * * *"` (napi 06:00), a scripted task-config módosítás UTÁN várj a holnap reggel 06:00-ig, és UTÁNA ellenőrizd a `command-task-health.json`-t.
- Ha a scripted task sürgős (pl. most kellene ellenőrizni), a `runScheduledTaskNow` függvényt KELL JAVÍTANI (`type === 'command'` ág bevezetése).

### 5. Verifikáció -- `command-task-health.json` (csak `type: 'command'` esetén)

Lásd `scripts/smoke-verify-health.py` -- `python3 scripts/smoke-verify-health.py <TASK_NAME>` ellenőrzi, hogy:
- `lastStatus === "ok"`
- `fails === 0`
- `lastRun` timestamp friss (< 60 másodperccel ezelőtti)

Ha FAIL: rollback a backup-ra + service restart, ha kell.

### 6. Verifikáció -- task_run history (`fired` + health lastRun timestamp egyezés)

```bash
TOKEN=$(cat ~/marveen/store/.dashboard-token)
TASK=<TASK_NAME>

curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/schedules/$TASK/runs" | python3 -m json.tool | tail -20
```

Az utolsó bejegyzés `status: "fired"` kell legyen, ÉS a scripted parancs tényleges végrehajtásának a task_run history timestamp-jével EGYEZŐ másodpercre kell történnie. Ha a task_run history új bejegyzés DE a health.json `lastRun` NEM frissült: silent skip történt (BUG-0015 tünet) -- rollback.

### 7. Verifikáció -- a scripted parancs oldaláról (opcionális, de ajánlott)

Ha a scripted parancs egy fájlt ír vagy Telegram üzenetet küld, ellenőrizni kell a scripted parancs valódi meglétét:

```bash
# Példa: MORNING.md frissült-e a run-now trigger óta
ls -la ~/marveen/MORNING.md  # mtime < 5 perc
head -5 ~/marveen/MORNING.md  # tartalom helyes
```

### 8. Rollback útvonal (HA bármelyik verifikáció FAIL)

```bash
TASK=<TASK_NAME>
LATEST_BAK=$(ls -t ~/.claude/scheduled-tasks/$TASK/task-config.json.bak-* | head -1)
cp "$LATEST_BAK" ~/.claude/scheduled-tasks/$TASK/task-config.json
echo "Rolled back to $LATEST_BAK"

# Service restart vagy 60s tick várakozás, hogy a runner újraolvassa
```

## Buktatók

- **NE bízz a `fired` státuszban önmagában.** A task_run history `fired` = a runner trigger elindult, NEM a scripted parancs sikeresen lefutott. A task_run history `fired` + `command-task-health.json` `lastStatus: "ok"` + `lastRun` timestamp egyezés KELL.
- **NE hagyd ki a backup-ot.** A scripted task_config módosítása rollback útvonal nélkül VAKREPKÜLDÉS a scripted task felett.
- **NE módosítsd a scripted task_config.json-t sleep előtt.** Ha a scripted task_config módosítása lefekvés előtt történik, a smoke run-now trigger azonnali verifikációja KIHAGYHATATLAN -- különben a scripted task holnap reggel is csendben meghalhat.
- **A `failThreshold` counter CSAK a scripted parancs FAILED futásaira nő.** A silent skip (hiányzó `command` mező) NEM NÖVELI a fail-számlálót -- ez a BUG-0015 legkritikusabb tanulsága. A `failThreshold: 10` védelem HASZNÁLHATATLAN silent skip ellen.
- **A Phase N scripted task_config módosításoknál különösen figyelj.** A scripted task_config edit gyakran más scripted task-config-ok touch-up-jával jár együtt, és a kézi edit hajlamos a `command` mező véletlen törlésére (BUG-0015 is TASK-0012 Sonnet split edit során történt).
- **"Szent prioritás" taskok (dream-engine `2 1 * * *`, reggeli-napindito/-monitor `06:00` sáv) élő config-ját NE módosítsd egyoldalúan, még backup+smoke test birtokában sem.** Ezek a napi riport megbízhatóságát hordozzák (lásd `feedback_priority_sacred.md`). Ha a szerkesztést (Edit tool-use) a felhasználó elutasítja, NE próbáld újra automatikusan -- kártyát blocked-ra, assignee=Alex, komment a pontos hátralévő lépéssel (2026-09-09, TASK-0031/658f69d2 pattern). A kódtámogatás (pl. új mező a task-config sémában) attól még commitolható/tesztelhető, csak az ÉLES config-fájl bekapcsolása vár jóváhagyásra.
- **A kapcsolódó kódváltozást (schedule-runner.ts, stb.) NE a fő checkoutban futtasd le teszttel/tsc-vel, ha `assert-not-live-install.ts` blokkol** ("REFUSING TO RUN TESTS: looks like a LIVE install"). Hozz létre egy ideiglenes `git worktree add ~/<name> HEAD`-et a HOME alatt (NEM `/tmp`), másold be a módosított fájlokat, `ln -s <main-repo>/node_modules node_modules` (nem kell `npm install`), futtasd ott a `vitest run <fájl>`-t és a `tsc --noEmit`-et, majd `git worktree remove ~/<name> --force`. Ha a `tsc --noEmit -p .` a fő repóban `FATAL ERROR: Reached heap limit` hibával OOM-ol, a worktree-s izolálás vagy a `node --max-old-space-size=4096 node_modules/.bin/tsc` general megoldja.

## Ellenőrzés checklist

- [ ] Backup készült (`task-config.json.bak-<timestamp>`)
- [ ] JSON séma-validáció átment (type mező konzisztens a kötelező mezőkkel)
- [ ] Run-now trigger sikeresen indította a scripted taskot (`ok: true` a válaszban)
- [ ] `command-task-health.json` (csak `type: 'command'`): `lastStatus: "ok"`, `fails: 0`
- [ ] task_run history: utolsó bejegyzés `fired` ÉS a scripted parancs tényleges végrehajtásának timestamp-je egyezik a task_run history trigger timestamp-jével
- [ ] A scripted parancs oldaláról is verifikálva (fájl/üzenet, ha van)
- [ ] Ha bármelyik lépés FAIL: rollback a backup-ra + service restart (ha szükséges)

## Helper scriptek (a `scripts/` almappában)

- `smoke-validate.py <TASK_NAME>` -- JSON séma-validáció
- `smoke-verify-health.py <TASK_NAME>` -- `command-task-health.json` ellenőrzés
- `smoke-rollback.sh <TASK_NAME>` -- legutóbbi backup visszaállítása
- `smoke-full.sh <TASK_NAME>` -- teljes end-to-end smoke test (backup + validate + run-now + health + run history verify)

## Referenciák (a `references/` almappában)

- `bug-0015-case-study.md` -- a BUG-0015 teljes esettanulmány, hogy MIÉRT fontos ez a skill
- `silent-skip-code-path.md` -- a `src/web/command-task.ts:83-86` silent skip kódútja, lépésről lépésre
- `fire-vs-success.md` -- a task_run history `fired` ≠ scripted parancs siker magyarázata

## Kapcsolódó

- **Memória (szabály)**: `~/.claude/projects/-home-alex-marveen/memory/feedback_scheduled_task_smoke_test.md`
- **Memória (gyökér ok)**: `~/.claude/projects/-home-alex-marveen/memory/project_root_cause_silent_skip_2026_09_02.md`
- **Memória (BUG-0015 tünet)**: `~/.claude/projects/-home-alex-marveen/memory/project_bug_0015_reggeli_send_command_field.md`
- **Scripted task kód**: `src/web/command-task.ts:83-86` (a silent skip helye)
- **Scripted task kód**: `src/web/schedule-runner.ts:1488-1493` (a `runCommandTask` hívás helye)
- **ADR-0001**: lokális skill a projektbe (NEM globális) -- ez a skill a `marveen/skills/` mappában van, nem a globális `~/.claude/skills/`-ben