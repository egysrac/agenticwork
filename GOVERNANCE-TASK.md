# Feladat: a MASTER GOVERNANCE v1.0 bevezetése (§74 sorrend)

Alex 2026-09-04-én ezt tette meg a mostantól **egyetlen** master governance
dokumentummá:

```
~/marveen/governance/JARVIS_MASTER_AGENTIC_OPERATING_MODEL.md   (v1.0)
```

Kapcsolódó: `governance/POLICY_VERSION.yaml`, `governance/versions/v1.0.md`
(írásvédett), `decisions/ADR-0004.md`.

**A telepítés megtörtént. A bevezetés NEM.** Ez a te feladatod.

## Amit már elvégeztem helyetted (ne csináld újra)

- **§27 Migration Mode**: pillanatkép + sor-sorrend + visszaállási pont
  `~/governance-checkpoints/20260904-152637/` (287 kártya sorrendje CSV-ben,
  CURRENT_STATE.yaml, PROJECT_MEMORY.md, decisions/, a skill-csomag, git HEAD)
- **§35 verziózás**: `POLICY_VERSION.yaml`, `active_version: 1.0`
- **§19**: ADR-0004 megírva
- **PROJECT_MEMORY.md**: hivatkozik a master dokumentumra

Vagyis a **§74 0. és 1. lépése kész**. Te a **2. lépéstől** indulsz.

## Amit kérek

Készíts egy **EPIC**-et és alatta kártyákat a §74 sorrend 2–12. lépéseire.
A 13–15. (email-triage) lépésekre **is** készíts kártyát, de `waiting`
állapotban és a lenti figyelmeztetéssel.

Minden kártyához: cél, elfogadási kritérium, függőség az előző lépéstől,
kockázati osztály (§28), és becsült komplexitás (§15).

```
2.  Legacy WIP egyeztetés          <- ITT KEZDD
3.  Runtime WIP=1 kikényszerítés
4.  VERIFY / REPAIR állapotok
5.  Javítási limit KÓDBAN
6.  Metrika-aggregáció
7.  Történeti alapvonal
8.  Context Gate canary
9.  Előtte/utána összehasonlítás
10. Context Gate fokozatos kiterjesztés
11. Dinamikus modell-routing
12. Minőségi PDCA
13. Email-triage a lane/WIP modell alatt   [JÓVÁHAGYÁSHOZ KÖTÖTT]
14. Napi email-összefoglaló                [JÓVÁHAGYÁSHOZ KÖTÖTT]
15. Havi email PDCA                        [JÓVÁHAGYÁSHOZ KÖTÖTT]
```

## Amire külön figyelj

**A 2. lépés a legkényesebb.** Most **34 aktív `in_progress`** kártya van
(összesen 287). A §29 kimondja: a régi `in_progress` **nem jelenti azt, hogy
fut**. Használj **metaadatot** (utolsó futás, utolsó frissítés, heartbeat,
lease, checkpoint megléte) — és a §70 szerint **TILOS** mind a 287 kártyát
LLM-mel átnézetni. Osztályozás: EXECUTING / READY_TO_RESUME / WAITING /
STALE / BLOCKED.

**Ne migráld tömegesen a backlogot** (§27, §31). A régi kártyák csak akkor
kapnak új sémát, amikor végrehajtásra kerülnek (just-in-time), és akkor is
csak **deltát** (§33).

**A 3. lépésnél vigyázz**: a `KANBAN_WIP_*` kapcsolók léteznek a kódban
(`src/config.ts` 310–313), de a `.env`-ben nincsenek beállítva, tehát most
mind `0` = korlátlan. A WIP=1 viszont a **§23–24 értelmében lane-enként**
értendő, nem globálisan — egy hosszú fejlesztési feladat nem blokkolhatja a
napi üzemet (reggeli riport, HA-figyelés). Előbb kell lane-modell, csak utána
a korlát.

**A 13–15. lépés (email) a §28 szerint CRITICAL osztályú:** törlés (Trash),
és automatikus válasz megbízott feladó nevében. Ehhez **Alex kifejezett
jóváhagyása kell**, és a §68 canary-sorrendet kell követni:
`csak osztályozás → címkék → naptár-írás → megbízott válaszok → Trash`.
**Ne kezdd el jóváhagyás nélkül.** A §55-ös `andrea.zavada` azonosítót
ellenőrzött, pontos e-mail-címre kell feloldani — **domaint kitalálni tilos**.

**A §36 a mérce**: egy lépés csak akkor DONE, ha a **deklarált szabály, a
futásidejű konfiguráció és a megfigyelt viselkedés is egyezik**. A
`POLICY_VERSION.yaml` compliance blokkját minden lépés után frissítsd.

## Munkamódszer

A dokumentum saját szabályai szerint: kis darabok, keresés olvasás előtt,
determinisztikus eszköz LLM előtt, ellenőrzés bizalom helyett, legfeljebb
2 javítási kísérlet, és minden lépés után checkpoint + CURRENT_STATE
frissítés.

A négy-szem elv él: a kockázatos lépéseket **Weinberg függetlenül**
ellenőrizze (§17 quality gate).

## Fontos sorrendi tény

A §74 nem tetszőleges: **a 11. (dinamikus routing) definíció szerint blokkolva
van, amíg a 6–7. (mérés, alapvonal) nincs meg** — mérés nélkül nincs mit
optimalizálni. Ne ugorj előre.

## Első visszajelzés

Amikor az EPIC és a kártyák megvannak, mondd meg: az EPIC azonosítóját, hány
kártya készült, és mi a 2. lépés első konkrét akciója.
