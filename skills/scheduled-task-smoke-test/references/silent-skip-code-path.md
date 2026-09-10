# A silent skip kódútja -- `src/web/command-task.ts:82-110`

## A függvény (teljes)

```ts
export function runCommandTask(task: ScheduledTask, now: number): void {
  if (!task.command) {
    logger.warn({ task: task.name }, "command task has no command, skipping")
    return  // <-- ITT TÖRTÉNIK A CSENDES KIHAGYÁS
  }
  const timeoutMs = task.timeoutMs && task.timeoutMs > 0 ? task.timeoutMs : 10_000
  const failThreshold = task.failThreshold && task.failThreshold > 0 ? task.failThreshold : 2
  const map = load()
  const { ok, detail } = runCommand(task.command, timeoutMs)
  const { next, action } = evaluateCommandResult(map[task.name], ok, failThreshold, now)
  map[task.name] = next
  persist()
  try { appendTaskRun(task.name, task.agent || "system") } catch { /* non-fatal */ }
  logger.info({ task: task.name, ok, detail, fails: next.fails, action }, "command task ran")
  // ...
}
```

## Lépésről lépésre, mi történik ha `task.command` üres

1. A `runCommandTask(task, now)` hívódik a `schedule-runner.ts:1488-1493`-ban, mert a main loop a scripted task `task.type === 'command'` ágát nézi.
2. A függvény első sora (`if (!task.command)`) IGAZ, mert a scripted task_config-ból a `command` mező hiányzik (vagy üres string).
3. A `logger.warn` KIÍR egy WARN logot a journal-ba: `"command task has no command, skipping"` + `task: <név>`.
4. A `return` kilép a függvényből.
5. **Semmi más nem történik:**
   - NEM hívódik `runCommand()` (a scripted parancs nem fut le)
   - NEM hívódik `evaluateCommandResult()` (a `fails` számláló nem nő)
   - NEM hívódik `persist()` (a `command-task-health.json` nem frissül)
   - NEM hívódik `appendTaskRun()` (a scripted task_run history NEM KAP új bejegyzést)
   - NEM hívódik `sendTelegramMessage()` (nincs alert)

## Miért kritikus ez a hiba

### 1. A `failThreshold` védelem HASZNÁLHATLAN

A scripted task_config tipikusan `failThreshold: 10` értéket tartalmaz (a `reggeli-napindito-send` is). Az elvárás: ha a scripted parancs 10-szer egymás után elbukik, a scripted task_run alert megy a Telegramon.

A scripted task `fails` számlálója CSAK a `evaluateCommandResult()` hívásban nő (`(prev?.fails ?? 0) + 1`), és CSAK `success === false` esetén. A silent skip NEM HÍVJA a `evaluateCommandResult`-et, tehát a `fails` számláló örökre 0 marad.

A scripted task `fails === 0` ÉS `lastStatus: "unknown"` (vagy hiányzik) marad, amíg a scripted parancs egyszer sem fut le. A scripted send task esetében ez 33+ órán át tartott.

### 2. A scripted task_run history HAMIS biztonságérzetet ad

A scripted task_run history (`/api/schedules/<name>/runs` endpoint) a scripted task_run táblát olvassa, amit az `appendTaskRun()` tölt. A silent skip NEM HÍVJA az `appendTaskRun`-t, tehát a scripted task_run history-ban a scripted send UTOLSÓ bejegyzése a régi scripted trigger (4M+ tokens, scripted send előtti scripted task).

A scripted task_run history-ban NINCS új bejegyzés 33+ órán át, DE a scripted task_run history `fired` státusz a RÉGI scripted trigger. Ha az operátor megnézi a scripted task_run history-t, láthatja, hogy "33 órája nem futott" -- de hajlamos lehet azt hinni, hogy "talán csak a scripted task_run history endpoint nem működik", vagy "a scripted task jelenleg disabled", vagy "a scripted task most pihenni fog".

### 3. A scripted task_run history `fired` ≠ scripted execution success

A scripted task_run history `fired` státusza a scripted task_run trigger-t jelenti (a scripted task_run scheduler elindult), NEM a scripted futás sikerét. A scripted task_run history `fired` + scripted task_run history `lastRun` timestamp egyezés KELL a scripted parancs tényleges végrehajtásával -- különben silent skip történt.

## Mit kellene tennie a függvénynek (javasolt javítás)

```ts
export function runCommandTask(task: ScheduledTask, now: number): void {
  if (!task.command) {
    // NE CSINÁLJON CSENDES SKIP-ET -- BUKJON FEL HANGOSAN
    logger.error({ task: task.name }, "command task has NO command field -- treating as failure")
    const map = load()
    const { next, action } = evaluateCommandResult(map[task.name], false, task.failThreshold ?? 2, now)
    map[task.name] = next
    persist()
    try { appendTaskRun(task.name, task.agent || "system") } catch { /* non-fatal */ }
    // Alert mehet, ha a fails elérte a failThreshold-et
    if (action === "alert") {
      const ownerChat = resolveOwnerChatId()
      if (TELEGRAM_BOT_TOKEN && ownerChat) {
        sendTelegramMessage(TELEGRAM_BOT_TOKEN, ownerChat, `\u{1F534} Hiba: ${task.name} scripted parancs HIÁNYZIK`)
      }
    }
    return
  }
  // ... eredeti logika
}
```

Ez a javítás AKTIVÁLNÁ a `failThreshold` védelmet silent skip ellen, ÉS a scripted task_run history kapna egy `failed` bejegyzést, ami látható a dashboardon.

## A scripted task_run history vs. scripted execution success

| scripted task_run history státusz | scripted execution valóság |
|--------------------------------------|---------------------------|
| `fired` (régi scripted trigger) | scripted parancs futott és sikeres volt (régen) |
| `fired` (új scripted trigger) | scripted trigger ELINDULT, de scripted parancs futásáról NINCS INFÓ |
| HIÁNYZÓ scripted trigger | scripted parancs NEM FUTOTT (silent skip VAGY service leállt) |
| `failed` scripted trigger | scripted parancs futott és ELBUKOTT |

A scripted task_run history `fired` önmagában NEM BIZONYÍTÉK. A scripted task_run history `fired` + scripted task `command-task-health.json` `lastStatus: "ok"` + scripted task `lastRun` timestamp friss ÉS egyező KELL.
