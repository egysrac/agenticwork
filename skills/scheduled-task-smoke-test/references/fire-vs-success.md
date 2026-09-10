# `fired` ≠ siker -- a task_run history félreértése

## A `task_runs` tábla

A scripted task_run history a `task_runs` SQLite táblában van. A scripted task_run history-t a dashboard `/api/schedules/<name>/runs` endpointja olvassa.

A scripted task_run history sémája:
- `id` (INTEGER PRIMARY KEY)
- `task_name` (TEXT) -- a scripted task neve (pl. `reggeli-napindito-send`)
- `agent` (TEXT) -- a scripted task futtató agent (pl. `jarvis`)
- `fired_at` (INTEGER, unix ms) -- a scripted task_run trigger időpontja
- `status` (TEXT) -- `fired`, `skipped`, `failed`, `completed`, stb.
- `tokens_est` (INTEGER, opcionális) -- az LLM-alapú scripted task-nál a becsült token használat

## A `fired` státusz eredete

A `fired` státuszt a scripted task_run scheduler (a `schedule-runner.ts` main loop) írja, amikor a scripted task_run-t ELINDÍTJA. A scripted task_run trigger a következőket jelenti:
- A scripted task_run scheduler a scripted task_run konfigot betöltötte
- A scripted task_run scheduler a scripted task_run típusnak megfelelő ágat választotta (pl. `type:'task'` → LLM, `type:'command'` → `runCommandTask`, `type:'heartbeat'` → LLM)
- A scripted task_run scheduler a scripted task_run-t TOVÁBBADTA a futtatónak (LLM trigger vagy `runCommandTask`)

A `fired` státusz NEM JELENTI:
- Hogy a scripted parancs (shell parancs) lefutott
- Hogy a scripted parancs sikeres volt
- Hogy a scripted parancs bármilyen side-effect-et produkált

## Különbség `fired` vs. valódi siker között

### `type:'task'` scripted task (LLM trigger)

A `type:'task'` scripted task a scripted task_run scheduler-ből az LLM session-be küldi a scripted prompt-ot. A scripted task_run history `fired` státusz a scripted prompt ELKÜLDÉSÉT jelenti.

A scripted parancs sikerét a scripted task_run history `completed` státusz jelenti (amit az LLM session végén a scripted task_run history-ba ír), VAGY a scripted LLM válaszának a scripted prompt-ra.

### `type:'command'` scripted task (shell parancs)

A `type:'command'` scripted task a scripted task_run scheduler-ből a `runCommandTask`-ba megy (`schedule-runner.ts:1488-1493`). A scripted task_run history `fired` státusz a scripted task_run scheduler trigger-t jelenti, NEM a scripted parancs futását.

A scripted parancs sikerét a `command-task-health.json` `lastStatus: "ok"` jelenti, amit a `runCommandTask` `evaluateCommandResult(success=true)` ága ír.

### `type:'heartbeat'` scripted task (LLM trigger, csendes)

Ugyanaz, mint a `type:'task'`, DE a scripted heartbeat CSAK fontos/sürgős dolgot ír a Telegramra. A scripted task_run history `fired` itt sem jelent sikert.

## Hogyan ellenőrizd a scripted parancs VALÓDI sikerét

### 1. `command-task-health.json` (csak `type:'command'`)

```bash
python3 ~/.claude/skills/scheduled-task-smoke-test/scripts/smoke-verify-health.py <TASK_NAME>
```

Ez ellenőrzi:
- `lastStatus === "ok"` (a scripted parancs legutóbb sikeresen futott)
- `fails === 0` (a scripted parancs nem bukott el a legutóbbi siker óta)
- `lastRun` timestamp friss (< 60 másodperccel ezelőtti)

### 2. A scripted parancs side-effect-je

Ha a scripted parancs fájlt ír vagy Telegram üzenetet küld, ellenőrizni kell a scripted parancs valódi meglétét:
```bash
# Példa: MORNING.md frissült-e a run-now trigger óta
ls -la ~/marveen/MORNING.md  # mtime < 5 perc
head -5 ~/marveen/MORNING.md  # tartalom helyes
```

### 3. A scripted task_run history timestamp egyezés

A scripted task_run history utolsó bejegyzés `fired` státusz, ÉS a scripted task_run history trigger timestamp-je EGYEZŐ másodpercre kell legyen a scripted parancs tényleges végrehajtásával. Ha a scripted task_run history új bejegyzés DE a scripted `command-task-health.json` `lastRun` NEM frissült: silent skip történt.

## A scripted task_run history `fired` FALSE POSITIVE esetei

1. **Silent skip** (`!task.command`): a scripted task_run history `fired` write ELŐTT return-öl a `runCommandTask`, tehát a scripted task_run history NEM KAP új bejegyzést -- DE a scripted task_run history-ban a RÉGI `fired` bejegyzés marad, ami scripted parancs sikerét SUGALLJA.
2. **Service leállás**: a scripted task_run scheduler leállt, a scripted task_run history `fired` NEM ÍRÓDIK, a scripted task_run history-ban a RÉGI `fired` bejegyzés marad.
3. **A scripted task_run scheduler trigger de a scripted execution fail**: a scripted task_run history `fired` write MEGTÖRTÉNIK (a scripted trigger ELINDULT), DE a scripted parancs később elbukik. A scripted task_run history NEM FRISSÜL `failed` státuszra, csak a scripted `command-task-health.json`.

## A scripted task_run history `fired` félreértése a BUG-0015-ben

A scripted task_run history-ban a scripted send UTOLSÓ bejegyzése 2026-08-31 12:55:23 (`1788173723258`, 4.4M tokens). A scripted task_run history `fired` státusz a scripted send UTOLSÓ sikeres scripted triggerét jelenti, ami 4.4M token-es scripted LLM trigger volt (a scripted send előtti scripted task).

A scripted task_run history `fired` + 4.4M tokens KONZISZTENS volt a scripted send scripted task run history-jával -- az operátor (Alex) azt hihette, hogy minden OK.

DE: a scripted task_run history `fired` a scripted task_run scheduler trigger-jét jelenti, NEM a scripted parancs sikerét. A scripted parancs (`/usr/bin/python3 /home/alex/marveen/scripts/send-morning.py`) 33+ órán át NEM FUTOTT, mert a scripted task_config-ból a `command` mező hiányzott.

## Tanulság

A scripted task_run history `fired` státusz NEM BIZONYÍTÉK. Mindig ellenőrizd:
- `command-task-health.json` (`type:'command'` esetén)
- A scripted parancs side-effect-je (fájl/üzenet)
- A scripted task_run history timestamp egyezés
