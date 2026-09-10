# EPIC: Master Governance Model v1.0 érvényesítése

**Governance:** `~/marveen/governance/JARVIS_MASTER_AGENTIC_OPERATING_MODEL.md` (v1.0, ACTIVE)
Ez mostantól a **master** dokumentum. A 2026-09-01-i „Marveen Agentic Operating
System" direktíva ebbe olvad be. Új protokoll nem önálló utasítás, hanem
verziózott kiegészítés (v1.1, v1.2…) a §35 szerint.

Alex 2026-09-04-én ezt fogadta el master governance-nek.

---

## A felderítés MÁR MEGVAN — ne csináld újra (§14)

A §74 0–2. lépése lefutott, determinisztikus SQL-lel, LLM nélkül (§29 előírása
szerint). Az eredmény:

### §36 Policy Compliance Gate — mért állapot

| Szabály | Deklarált | Futásidejű | Megfigyelt | Ítélet |
|---|---|---|---|---|
| §19 ADR-ek | van | 3 db | rendben | KÉSZ |
| §11 Context Gate | van | `src/context-gate.ts` 248 sor, 18/18 teszt, recall endpoint | opt-in, default OFF, `qwen_relevance_filter_calls: 0` | TELEPÍTVE ≠ AKTÍV (§37) |
| §18/§20 memória + állapot | van | `PROJECT_MEMORY.md`, `CURRENT_STATE.yaml` | 2026-09-02 óta nem frissült | RÉSZLEGES |
| §13 routing | van | `ROUTING_POLICY.md`, `scripts/ask-model.sh`, Qwen elérhető | nincs mérve | RÉSZLEGES |
| §23 WIP | van | `KANBAN_WIP_*` = 0 (korlátlan) | 34 szellem-WIP | NINCS |
| §30 lease | van | nincs lease/heartbeat/owner oszlop | ghost WIP nem szűrhető | NINCS |
| §7 VERIFY/REPAIR | van | a kanban nem ismeri | — | NINCS |
| §16 repair limit 2 | van (`FAILURE_POLICY.md`) | nincs kódban | — | NINCS |
| §39 metrikák | van | nincs `metrics/agent_metrics.jsonl` | `token_usage` 11 592, `task_runs` 11 355 sor NYERSEN megvan | NINCS |
| §44–65 email triage | van | semmi | — | EL SEM KEZDVE |

### §29 Legacy WIP reconciliation — mért adat

```
in_progress kártya (nem archivált):        34
ebből EXECUTING (van dispatched_at):        0
mind utoljára módosítva:            2026-08-30 (ugyanaznap)
lease/heartbeat/owner oszlop:              nincs
```

**Következtetés:** ez nem 34 párhuzamos munka, hanem **34 szellem-WIP**. Mivel
nincs lease-mező, a rendszer szerkezetileg nem tudja megkülönböztetni a futót az
elakadttól — ezért halmozódott fel. A §23 szerint a WIP **sávonként** értendő
(§24), tehát a cél nem „egy kártya összesen", hanem sávonként egy futó darab.

---

## A végrehajtás sorrendje — §74, NE rendezd át

```
[kész]  0. Governance freeze
[kész]  1. Current state snapshot
[kész]  2. Legacy WIP reconciliation
        3. Runtime WIP=1 érvényesítés (sávonként, §23-24)
        4. VERIFY / REPAIR állapot támogatás (§7)
        5. Repair limit KÓDBAN (§16)
        6. Metrics foundation (§39)
        7. Historical baseline (§40 — NE találj ki visszamenőleges FPY-t)
        8. Context Gate canary (§37)
        9. Before / after összevetés
       10. Context Gate fokozatos élesítés
       11. Dynamic routing (§13)
       12. Quality PDCA (§42)
       13-15. Email triage (§44-65) — külön epik, csak ezután
```

**A sorrend nem tetszőleges.** A §26 és §40 kimondja: mérés nélkül nincs
optimalizálás, és a megbízható FPY-mérés csak onnantól kezdődhet, ahol a
VERIFY/REPAIR állapotok futásidőben érvényesülnek. Ezért a 11. lépés (dinamikus
routing) **definíció szerint blokkolva van**, amíg a 4–6. nincs meg.

## Első három konkrét lépés

**3. lépés — WIP:** a `KANBAN_WIP_*` kapcsolók már léteznek a
`src/config.ts`-ben (302–313. sor), csak nincsenek beállítva. Ez a leggyorsabb
valódi nyereség. Előtte viszont a 34 szellem-WIP-et rendezni kell — különben a
limit azonnal blokkol mindent. A §31 szerint **ne tömegesen migrálj**: a
szellem-kártyák maradjanak, csak ne számítsanak futónak.

**4-5. lépés — lease + állapotok:** a `kanban_cards` táblához kell
`lease_owner` / `lease_started_at` / `heartbeat_at` (§30), és a VERIFY/REPAIR
állapot (§7). Innen már kiszűrhető a ghost WIP, és a repair limit (§16)
kódban érvényesíthető. **Migráció: adatvesztés nélkül, visszaállítható
ellenőrzőponttal.**

**6. lépés — metrikák:** a nyersadat megvan (`token_usage`, `task_runs`).
A §39 kifejezetten determinisztikus SQL-aggregálást kér, nem LLM-elemzést.

## Kötelező munkamód

- Minden lépés külön TASK-XXXX, saját acceptance criteria-val (§5, §8).
- **Négy-szem elv** (Alex állandó szabálya): a kockázatosakat Weinberg
  függetlenül is ellenőrzi, a saját protokollja szerint.
- Ellenőrzőpont minden sikeres task után (§9, §22), `CURRENT_STATE.yaml`
  frissítve — az most 2026-09-02 óta áll.
- ADR minden szerkezeti döntéshez (§19).
- **Az éles fán a commitot Alex futtatja** (`MARVEEN_PROD_COMMIT_OK` guard).
- A gépen ma három nagy változás történt (Claude-motor, CLI 2.1.110 rögzítve,
  WiFi a jó AP-ra kötve). Ezekhez **ne nyúlj**.

## Kész állapot

Az epik akkor kész, ha a §36 táblázat 3–6. sora mindhárom oszlopban egyezik,
és ezt **mért adat** igazolja, nem dokumentáció.
