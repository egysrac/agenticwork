# TASK-0022 — FPY / történeti alapvonal, 2026-09-08

Epic: governance-v1 (453763cc), §74/7. lépés, kártya `c98b74d1`.
Függőség: TASK-0021 (kártya `7a3969c5`, kész, `metrics/agent_metrics.jsonl`, `task-0021.sql.v1`).

**Módszer:** `store/claudeclaw.db` közvetlen lekérdezése python3 `sqlite3` modullal
(NEM `sqlite3` CLI — nincs telepítve), plusz a TASK-0021 kimeneti JSONL fájl idézése.
Minden szám alatt a pontos forrás (lekérdezés vagy fájl+mező) és időszak szerepel.

## 1. Klasszikus FPY (első próbálkozásra sikeres, verifikált végrehajtás)

**NINCS ADAT: nincs olyan forrástábla, amely rögzítené egy feladat első
verifikációs kimenetét.**

A TASK-0021 aggregáció ezt már explicit dokumentálta a saját `unknown` mezőjében
(`metrics/agent_metrics.jsonl`, mindkét sor, `unknown.first_pass_success`):

> "first verification outcome cannot be reconstructed"

és

> "verification and repair history is not recorded by either source table"

Ez a `token_usage` (LLM-hívás napló) és `task_runs` (ütemező-esemény napló) forrásokra
vonatkozik — ezekben nincs task-azonosító, nincs siker/hiba mező, nincs javítási
számláló. `unknown.task_id`: "no reliable task/session foreign key exists between
token_usage and task_runs" — a két tábla nem is köthető össze feladat-szinten.

**Nem pótoltam becsléssel.** A §40 tiltás miatt ez a szám explicit hiányzik, nem
közelítettem semmilyen proxy-val.

## 2. A workflow_state/repair_attempts oszlopok (TASK-0019 migráció) alapján

**Forrás:** `python3 sqlite3` közvetlen lekérdezés, `store/claudeclaw.db`,
`kanban_cards` tábla, futtatva 2026-09-08 (aktuális session).

```sql
SELECT COUNT(*) FROM kanban_cards;
-- 312

SELECT workflow_state, COUNT(*) FROM kanban_cards GROUP BY workflow_state;
-- NULL:    308
-- 'done':    3
-- 'running': 1

SELECT repair_attempts, COUNT(*) FROM kanban_cards GROUP BY repair_attempts;
-- 0: 312  (mind a 312 sor)

SELECT COUNT(*), MIN(created_at), MAX(created_at), MIN(updated_at), MAX(updated_at)
FROM kanban_cards WHERE workflow_state IS NOT NULL;
-- n=4, created_at: 2026-09-04T13:34:22Z .. 2026-09-04T13:34:23Z
--       updated_at: 2026-09-08T05:32:19Z .. 2026-09-08T10:18:18Z
```

**NINCS ADAT: ez a 4 sor nem reprezentatív mintavétel, hanem a governance-epic
saját nyomkövető kártyái (TASK-0019, TASK-0020, TASK-0021, TASK-0022 maga).**

Indoklás:
- A TASK-0019 migráció kódja (`src/db.ts` ~331-386. sor) szerint a `workflow_state`
  oszlop **NEM** kap visszamenőleges backfill-t a régi kártyákra ("Legacy rows stay
  NULL until an explicit workflow/status write" — kommentből idézve). Csak akkor
  töltődik ki, ha (a) egy új sor explicit workflow_state-tel jön létre, vagy (b) egy
  meglévő sor `status` mezője megváltozik, és ekkor az `AFTER UPDATE OF status`
  trigger (`kanban_workflow_reconcile_legacy_status`) visszaszámolja a `status`-ból.
- A 3 db `workflow_state='done'` sor pontosan a TASK-0019/0020/0021 kártyák
  (`a685d4f9`, `ff932729`, `7a3969c5`) — ezt közvetlen lekérdezéssel igazoltam,
  nem feltételezésből mondom. A 4. sor (`workflow_state='running'`) maga `c98b74d1`
  (TASK-0022, ez a kártya).
- Ablak: `created_at` mind a négyre 2026-09-04 (amikor az epic kártyák létrejöttek),
  `updated_at` 2026-09-08 05:32–10:18 között (kb. 5 óra) — ez alatt mozgatták a
  kártyákat `done`/`running` felé a mai session(ök) során.
- **n=4, mind az epic saját adminisztratív kártyája, 0 db "normál" munkakártya
  közte.** Ebből sem FPY, sem repair-arány nem számolható úgy, hogy az bármilyen
  általános kártya-populációra reprezentatív lenne.

**`repair_attempts` oszlop külön csapda, amit dokumentálni kell:** az oszlop
`NOT NULL DEFAULT 0` megkötéssel jött létre (`ALTER TABLE ... ADD COLUMN
repair_attempts INTEGER NOT NULL DEFAULT 0`). SQLite-ban ez a DEFAULT
**minden meglévő sorra visszamenőleg kitöltődik** — tehát mind a 312 sor
`repair_attempts=0`, függetlenül attól, hogy érintette-e valaha a §16 szerinti
javítási folyamatot. Ez **nem** jelenti azt, hogy egyetlen kártya sem igényelt
javítást — csak azt, hogy az oszlop léte önmagában nem különbözteti meg az
"érintetlen" és a "0 javítással átment" sorokat.

**Amit ebből biztonságosan ki lehet jelenteni** (szűken körülhatárolva, a saját
governance-epic 3 lezárt kártyájára, nem általánosítva):

> A governance-v1 epic 2026-09-08-ig lezárt 3 kártyája (TASK-0019 `a685d4f9`,
> TASK-0020 `ff932729`, TASK-0021 `7a3969c5`) mindegyike `repair_attempts=0`
> állapotban érte el a `done` állapotot — vagyis az alkalmazás auditált
> `/move` API-ján keresztül egyik sem lépett be dokumentáltan a §16 szerinti
> javítási körbe.
> **Forrás:** fenti SQL, `store/claudeclaw.db`, `kanban_cards.workflow_state='done'`.

Ez **nem FPY** a szó statisztikai értelmében (n=3, nem véletlen minta, az epic
saját feladatai magukról az epic-szabályokról), csak egy pontos, igaz megfigyelés
erről a 3 kártyáról.

## 3. TASK-0021 baseline számok idézve (nem újraszámolva)

**Forrás:** `metrics/agent_metrics.jsonl`, `aggregation_version: "task-0021.sql.v1"`,
`agent: "jarvis"` sor, `observed.task_runs` és `observed.token_usage` mezők.

```
observed.task_runs.status_counts (agent=jarvis, 17444 sorból 16939+ jarvis):
  fired:            11752
  lost:               4567
  skipped:            1080
  missing-retrying:     41
  failed:                2
  missed:                2

observed.task_runs első/utolsó timestamp: 2026-08-19T08:45:03Z .. 2026-09-08T10:16:21Z
observed.token_usage első/utolsó timestamp: 2026-08-19T08:37:10Z .. 2026-09-08T09:31:45Z
```

**KRITIKUS FIGYELMEZTETÉS, amit a TASK-0021 kimenet maga is leír**
(`unknown.result`, idézve):

> "task_runs.status records scheduler events, not verified task outcomes"

Vagyis a `failed`/`lost`/`missed`/`skipped` státuszok **ütemező-szintű
eseményeket** jelölnek (pl. a tmux session nem futott, a cron nem tüzelt,
a küldés elveszett), **NEM** azt, hogy egy feladat tartalmilag hibásan lett
végrehajtva vagy hogy hány próbálkozásra sikerült. Ebből FPY-t számolni
(pl. `fired / (fired+failed+lost+...)`) **módszertanilag hibás** lenne — ez
pontosan az a fajta becslés, amit a §40 tilt. **NEM számoltam ilyen arányt.**

## Összegzés

| Kérdés | Válasz | Forrás |
|---|---|---|
| Klasszikus FPY (első verifikációra sikeres feladat-arány) | **NINCS ADAT**: nincs forrás, ami első verifikációs kimenetet rögzítene | `metrics/agent_metrics.jsonl`, `unknown.first_pass_success` |
| Repair-arány kanban `repair_attempts` alapján | **NINCS ADAT** ált. populációra: az oszlop minden sorra 0-val backfillelt, nem különböztet | SQL fent, `kanban_cards.repair_attempts` |
| Repair-arány a workflow_state-tel érintett kártyákra | n=4, ebből 3 a saját governance-epic kártyája (nem reprezentatív minta) | SQL fent, `kanban_cards.workflow_state` |
| Ütemező fired/failed/lost arány mint FPY-proxy | **Módszertanilag hibás lenne**, nem számoltam | `metrics/agent_metrics.jsonl`, `unknown.result` |
| Amit biztonságosan ki lehet jelenteni | A 3 lezárt governance-kártya (TASK-0019/20/21) mindegyike 0 dokumentált javítási körrel jutott `done`-ba | SQL fent |

**Konklúzió:** jelenleg nincs elég/megfelelő nyersadat egy statisztikailag
értelmes, visszamenőleges FPY-alapvonalhoz. Az egyetlen releváns forrás-tábla
(`kanban_cards.workflow_state`/`repair_attempts`) csak kb. 1 napja (2026-09-07/08
óta) létezik, és eddig kizárólag a governance-epic saját adminisztratív kártyáit
érintette. Ahhoz, hogy valódi FPY-alapvonal legyen, több "normál" munkakártyának
kell végigmennie a §7 állapotgépen (`ready→running→verify[→repair]→done`) —
ez idővel magától gyűlik, amint a `/move` API-t a többi kártyára is használják.
