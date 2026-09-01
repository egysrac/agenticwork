# PROJECT_MEMORY.md

A Marveen projekt tartós tudása. NEM krónológiai tevékenység-napló, hanem csak az a tudás, ami tartósan releváns a rendszer megértéséhez és működtetéséhez.

A `skills/marveen-agentic-dev/SKILL.md` a TASK-kezelés szabályait írja le, ez a fájl a PROJEKT-tudást. Architektúra döntések a `decisions/ADR-XXXX.md` fájlokban.

## Architecture

### Stack
- **Runtime**: Node.js + TypeScript (511 TS/JS a `src/`-ben, strict TS)
- **Perzisztens state**: SQLite (`store/claudeclaw.db`, ~9 MB) -- kanban + memória + scheduled tasks + üzenetek + napi napló + autonómia config egy DB-ben
- **Dashboard API**: `http://localhost:3420` (Bearer token: `store/.dashboard-token`)
- **Telegram bridge**: `~/.local/share/marveen-bridge/bridge.py` (Python) -- NEM a Claude Code Channels plugin (az OAuth-os, a flotta MiniMax-M3-on fut)
- **Build**: `dist/` (TS → JS), tesztek: `vitest` (`vitest.config.ts`)
- **Háttér-jobok**: `scripts/agent-msg.sh`, `POST /api/background-tasks` -- MiniMax-M3 modellel futnak (olcsó, korlátlan)

### Gépek
- **Marveen host (ASUS 1215N)** -- 4 CPU, 3.8 GB RAM, 5 GB swap. Fő feladat: OpenClaw/Marveen orchestration, Telegram, task queue, persistent state, Git, lightweight shell. Alacsony CPU/RAM terhelés (WIP=1, ne terheld). Saját Ollama CSAK embedding modellekkel: `all-minilm` (45 MB), `nomic-embed-text` (274 MB).
- **HA NUC (BoxNUC8i3BEH2)** -- i3 8. gen, 8 GB RAM, 120 GB SSD. HAOS 18.2 + Ollama. LAN: `192.168.1.53`. Modellek: `qwen2.5:3b` (3.1B Q4_K_M, 1.9 GB), `minicpm-v:latest` (7.6B qwen2-alapú multimodal), `nomic-embed-text`. SSH port 22 zárva (HAOS), Ollama API port 11434 él.

## Coding Conventions

- TypeScript strict mode (`tsconfig.json`)
- Verifikáció: `npm run typecheck` + `npm run syntax-check` + `npm test` (vitest)
- Patch, ne teljes fájl újraírás (ha a változás < 50% a fájlból)
- Conventional commits: `feat:` / `fix:` / `chore:` / `test:` / `docs:` + utótag (pl. `BGPMODE826`)
- Fő branch: `develop`
- Coding style: a meglévő `src/` kódot követi (a TS compiler + ESLint config irányadó)
- Locale: kód/komment/technikai docs angolul; Alex felé magyarul (kivéve emailek aláírása, ld. CLAUDE.md)

## Operating Assumptions

- **WIP = 1** -- egy aktív TASK/dev folyamat; background-job MiniMax-M3-on futhat párhuzamosan
- **Retry**: max 2 autonóm repair, utána BLOCKED + structured failure report
- **Cloud model**: MiniMax proxy-n át (`ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic`); `ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-6` (Sonnet default, TASK-0010 bevezetve 2026-09-01), `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-6` (Opus escalation), `MAIN_AGENT_MODEL=claude-opus-4-6` (főágens), `DEFAULT_AGENT_MODEL=claude-opus-4-6` (háttér-jobok -- TASK-0011-ben megy Sonnet-re a Context Gate integrációval)
- **Local Qwen**: HA NUC Ollama (`qwen2.5:3b`), `OLLAMA_URL=http://192.168.1.53:11434` a `.env`-ben
- **RESPAWN_ENABLED=0** -- respawn ki, a channel-plugin monitor nem indul el
- **Háttér-jobok (jarvis-worker)**: MiniMax-M3 modellel, olcsó + korlátlan
- **Főágens (Jarvis)**: Claude / Opus (drága, de magas minőség)

## Infrastructure & Interfaces

### Dashboard API (http://localhost:3420)
- Bearer auth: `Authorization: Bearer $(cat store/.dashboard-token)`
- Endpoints (kanban, memory, daily-log, agents, messages, schedules, background-tasks, approvals): lásd `CLAUDE.md` és a dashboard route-ok a `src/web/`

### Ollama (HA NUC: 11434)
- Models: `qwen2.5:3b` (3.1B Q4_K_M, 1.9 GB, completion+tools), `minicpm-v:latest` (7.6B qwen2-alapú, completion+vision), `nomic-embed-text` (137M F16, embedding)
- Endpoints: `POST /api/generate`, `GET /api/tags`, `GET /api/ps`, `GET /api/version`
- A Marveen kód a `src/qwen-router.ts`-on át hívja (90s timeout, fallback Anthropic-ra)

### HA REST (https://192.168.1.53:8123)
- HA 2026.x default: :8123 HTTP listener **ZÁRVA** (empty reply), NEM redirectel -- LAN-ról is `https://` kell
- Automations: `POST /api/config/automation/config/{id}` az elsődleges (REST API), SSH csak végső menedék

### Telegram bridge
- `~/.local/share/marveen-bridge/bridge.py` (Python)
- A híd küldi el a Telegram üzeneteket, amiket a Jarvis kiír
- A `reply` MCP tool NEM elérhető (a flotta M3-on fut, OAuth-ot igényelne)

## Constraints

- **Cloud token budget**: `ANTHROPIC_MODEL=claude-opus-4-6` drága; Phase 2 split (Sonnet default + Opus escalation) kötelező a hatékony működéshez
- **WIP=1**: párhuzamosság NEM alapértelmezett
- **M3 háttér-job promptméret**: 5+ KB promptot specnek vesz és leáll a kódolás előtt -- rövid prompt + részletes terv a memóriában
- **9M+ context**: scheduled-task scripted Telegram küldésnél a modell nem jut el a curl-ig -- dream-engine FÁJLBA ír (02:07), 06:00 command típusú shell script küldi
- **Kanban rendszer**: 144 aktív kártyával működik, NEM szabad újraírni, csak TASK-XXXX prefix-szel kiegészíteni a title-ben
- **42 globális skill** (`~/.claude/skills/`): flotta-szintű, NEM szabad piszkálni. Lokális skill a projekt `skills/` mappájába (a `seed-skills/` mintájára)
- **M3 vs Claude modell minőség**: M3 gyengébb; főágens maradjon Claude/Opus, M3 csak tiszta mechanikus háttér
- **HAOS-ból NEM megoldható szoftveresen boot-várakozás** -- HAOS RAUC A/B slot rendszer, GRUB `boot_delay` hatástalan; egyetlen út a NUC BIOS "Power On Delay" (BoxNUC8i3BEH2: F2 a boot-nál, Power menü)

## Lessons (tartós tanulságok)

### HA / Home Assistant
- **HAOS GRUB `boot_delay` változót NEM fogadja el** -- HAOS RAUC A/B slot rendszert használ; `boot_delay=300` hatástalan, sőt rebootkor felülírja. Várakozás szoftveresen NEM megoldható a HAOS-ból; egyetlen út a NUC BIOS "Power On Delay" (BoxNUC8i3BEH2: F2 a boot-nál, Power menü)
- **HA HTTPS-only LAN-on is** (2026.x default) -- `:8123` HTTP listener zár (empty reply), NEM redirectel; LAN-ról is `https://`-t kell használni
- **HA REST POST automation config** -- HA 2026.8.3-ban a `POST /api/config/automation/config/{id}` él, MINDIG EZ AZ ELSŐ; SSH csak végső menedék (Alex feedback 2026-08-31: "ne legyen ilyen nehéz")
- **HAOS kernel-only állapot = áramszünet** -- ping OK + minden service refused = fizikai reboot kell, WoL nem segít
- **HAOS host SSH vs Terminal & SSH addon** -- a 22-es port a HAOS host SSH (Advanced SSH), nem az addon; az addon hoszt portja a supervisor proxy-ban van
- **HA klíma periodic_check** -- a `klima_be` automation 10 percenként visszakapcsolta a klímát; time condition a choose blokkban a megoldás (2026-08-31)

### Marveen rendszer
- **A Marveen host saját Ollama-ján soha nem volt qwen** -- csak embedding modellek (`all-minilm`, `nomic-embed-text`). A `qwen2.5:3b` a HA NUC-on fut, NE keverd a kettőt
- **HA NUC SSH (22) zárva**, de az Ollama API (11434) él -- LAN-ról a 11434-es porton át érhető
- **M3 háttér-job promptméret-korlát** -- 5+ KB promptot specnek vesz és leáll a kódolás előtt; rövid prompt + részletes terv a memóriában
- **Modell minőség: M3 vs Claude** -- M3 gyengébb; főágens maradjon Claude/Opus, M3 csak tiszta mechanikus háttér
- **"Inline results, not summaries"** -- nyers adatot/concrete listát a chatbe, ne csak összesített kategóriákat
- **Production-only bug testing** -- stateful/external/timing: unit teszt csődje, integrációs teszt + checklist kötelező
- **"Ígért emlékeztető durable legyen"** -- session-only CronCreate elvész session-restartkor; "emlékeztess"-nél mindig durable:true
- **"Naptári emlékeztető = iCloud-ba írni"** -- "emlékeztess"-nél icaldav.py create, ne scheduled task; ott nem látja és nem bízik benne

### Workflow / kommunikáció
- **Telegram bridge ≠ Claude Code Channels** -- a híd `~/.local/share/marveen-bridge/bridge.py`, NEM a plugin (az OAuth-os, flotta M3-on fut)
- **Nincs `reply` MCP tool** -- amit a Jarvis kiír, a híd küldi el; külön küldéshez a Telegram Bot API használható
- **Inter-agent üzenet verify + retry** -- a `scripts/agent-msg.sh` helper kötelező (HTTP-státusz + `id` ellenőrzés + 3x újraküldés + hiba-napló)
- **Sub-ágens ismeretlen-sender ping** -- allowlist-összevetés a `~/.claude/channels/telegram/access.json` `allowFrom`-ból; ha nincs benne → DEFAULT-DENY, escalate Alex-hez
- **Napi jelentő 06:00-kor** -- Alex minden nap 06:00-kor várja a reggeli jelentőt; ön-javító ciklus kell (`*/10 6-8 * * *` monitor + retry-loop + failThreshold=10)
- **SCHEDPRESEND826 buffer-leak javítás** -- PRE-send guard + wedge-detektor (`paneShowsContextSaturation`); `wedge-skip` retry reason-t ír
- **Approval formátum** -- approval kérésnél: proposed action / reason / risk / rollback / recommended decision; várj jóváhagyásra

### Operatív
- **"Reggeli ön-javító ciklus"** -- ha 06:00-kor a napi jelentő nem megy ki, a rendszer addig próbálkozzon, amíg meg nem jön (Alex kérése 2026-08-31)
- **Self-improvement PDCA** -- PLAN (mért inefficacy) → DO (kis kontrollált változtatás) → CHECK (metrikák összehasonlítása) → ACT (megtart/módosít/von vissza)

## Frissítési irányelvek

- **NEM kronológiai napló** -- ne dátum-szerinti tevékenységeket írj, hanem TARTÓS TUDÁST
- **Maximum ~ 200 sor** -- ha hosszabb, bontsd almappára (`docs/lessons/`, `docs/architecture/`) vagy ADR-ekre
- **Elavultat kivezetem** -- ha egy tanulság már nem érvényes (régi rendszer, frissített stack), TÖRÖLD, ne kommentáld ki
- **Új ADR-ek**: a fontos architektúra-döntéseket a `decisions/ADR-XXXX.md` fájlokba, ne ide
- **Kód-konvenciók** -- a részletes TS / TSX / Python stílus a meglévő kódból tanulható, nem kell külön style-guide