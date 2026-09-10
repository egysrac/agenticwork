# BUG-0015 Esettanulmány -- a scripted send 33+ órás csendes halála

## Időrend (CEST, 2026-08-31 -- 2026-09-02)

| Időpont | Esemény |
|---------|---------|
| 2026-08-31 12:41 | A `task-config.json` elveszti a `command` mezőt (Sonnet split TASK-0012 edit során) |
| 2026-08-31 12:55:23 | Utolsó sikeres scripted trigger (`1788173723258`, 4.4M tokens -- scripted send előtti scripted task) |
| 2026-08-31 13:00 - 2026-09-02 06:00 | **33+ óra csendes halál** -- a scripted send trigger NEM történik meg, mert `runCommandTask` csendben return-öl a `!task.command` ágon |
| 2026-09-02 06:00:14 | A scripted task_run history 06:00:14-es main loop tick-je: `command task has no command, skipping` (WARN log, semmi több) |
| 2026-09-02 06:31 | Service restart (`marveen-dashboard.service` új PID 1036741) |
| 2026-09-02 06:35 | BUG-0015 felfedezés: a scripted send task_run history UTOLSÓ bejegyzése 41 órája |
| 2026-09-02 06:40 | Manuális javítás: `command` mező visszaállítása a `task-config.json`-ba |
| 2026-09-02 06:40:36 | Első run-now trigger a javítás után (`result: "jarvis: fired"` -- de LLM path, nem scripted command) |
| 2026-09-02 06:57:47 | Második run-now trigger (ugyanaz: LLM path) |
| 2026-09-02 07:00+ | A scripted task_config deploy smoke teszt run-now triggerrel NEM MŰKÖDIK (5. réteg bug: run-now endpoint nem honorolja type:'command'-ot) |

## A scripted task_run history bizonyítéka

A `/api/schedules/reggeli-napindito-send/runs` history-ban:
- Utolsó scripted trigger ID: `1788173723258` (2026-08-31 12:55:23 CEST)
- A scripted send task 06:40:36 és 06:57:47 run-now trigger ID-k: `1788324036600`, `1788325067140`
- A scripted send task 06:00:14-es cron-driven main loop trigger: NEM KERÜL BE a scripted task_run history-ba, mert a `runCommandTask` `!task.command` ága ELŐTTE return-öl, mielőtt az `appendTaskRun` hívódna

A scripted task_run history-ban a 06:00:14-es cron tick-hez tartozó scripted parancs **NINCS BENNE**, mert:
1. A scripted task `type:'command'`, tehát a main loop a `runCommandTask(task, now)`-t hívja (sor 1488-1493)
2. A `runCommandTask` a `!task.command` ágon return-öl (`command-task.ts:83-86`)
3. Az `appendTaskRun` sosem hívódik, mert a `runCommandTask` a 4. sorban (sor 94) van, a return a 6. sorban (sor 85)

## Mit látott az operátor (Alex)

- A scripted send task `enabled: true`, schedule `0 6 * * *`, a scripted send parancs látszólag "fut" (a scripted task_run history-ban a `fired` státusz RÉGI, de nincs újabb hibaüzenet)
- A scripted send Telegram üzenetek nem jönnek be
- A scripted send `.morning-last-sent` marker fájl nem frissül
- A scripted send `reggeli-monitor-0605` heartbeat is csendben van, mert a monitor a `.morning-last-sent` mtime-ját ellenőrzi (ami nem frissül)

## Miért kritikus a scripted send

A scripted send (`reggeli-napindito-send`) a reggeli ön-javító ciklus kulcsa:
- A scripted send `MORNING.md` fájlt ír + `send-morning.py` szkriptet futtat (Telegram üzenet)
- A scripted send nélkül nincs napi jelentő
- A scripted send nélkül a monitor sem látja, hogy bármi baj van
- A scripted send **sacred schedule** (lásd `feedback_priority_sacred.md`)

## Kiváltó ok: TASK-0012 Sonnet split edit

A scripted task_config módosítása 2026-08-31 12:41-kor történt, amikor a Sonnet split (TASK-0012, Phase 2 checkpoint) során több scripted task_configot is szerkesztettek egyszerre. A scripted task_config edit gyakran más scripted task-config-ok touch-up-jával jár együtt, és a kézi edit hajlamos a `command` mező véletlen törlésére.

A scripted task_config mtime-változás önmagában NEM JELENT problémát -- de a scripted task_config edit UTÁN nincs smoke test, és a scripted task_run history `fired` státusza hamis biztonságérzetet ad.

## Tanulság

A scripted task_config edit egy **kritikus infrastruktúra-változtatás**, nem "egy kis config tweak". A scripted task_config módosítás UTÁN:
1. Mindig backup a JSON-ról (rollback útvonal)
2. Mindig JSON séma-validáció
3. Mindig run-now trigger (DE: csak `type:'task'`, `type:'heartbeat'`, `type:'dream-engine'` esetén; `type:'command'`-nál a következő cron tick a helyes)
4. Mindig `command-task-health.json` ellenőrzés (csak `type:'command'`)
5. Mindig task_run history ellenőrzés (`fired` + timestamp egyezés)
6. Mindig a scripted parancs oldaláról is verifikálás (fájl/üzenet)
