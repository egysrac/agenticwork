---
name: marveen-agentic-dev-routing
description: Routing policy. Model routing (LEVEL 0/1/2/3), Local Qwen role (8 felelősség), Context Gate integráció, escalation package formátum, anti-patterns.
---

# Routing Policy

## Alapelv

**A legalacsonyabb költségű képes szintet választom.** LEVEL 3 (Opus) SOHA nem default -- csak escalation.

```
LEVEL 0: deterministic tool         (ingyenes, azonnali)
LEVEL 1: local Qwen (qwen2.5:3b)    (LAN, ~ 4-10 tok/s)
LEVEL 2: cloud coding (Sonnet)      (cloud, költséges)
LEVEL 3: strong reasoning (Opus)    (cloud, nagyon költséges)
```

## Routing döntési fa

Minden TASK-ra / lépésre:

```
Tudom determinisztikus eszközzel?    → LEVEL 0
Tudom local Qwen-nel?                → LEVEL 1
Tudom cloud coding-gal?              → LEVEL 2
Csak strong reasoning kell?          → LEVEL 3 (escalation)
```

## Példák (routing mátrix)

| Feladat                              | LEVEL | Eszköz            |
|--------------------------------------|-------|-------------------|
| Fájl keresés                         | 0     | `rg` / `grep`     |
| Log filter                           | 0     | `grep` / `awk`    |
| Status / health check                | 0     | `systemctl` / `curl` |
| Log summarization                    | 1     | qwen2.5:3b        |
| Task classification                  | 1     | qwen2.5:3b        |
| Email category detection             | 1     | qwen2.5:3b        |
| Relevance ranking                    | 1     | qwen2.5:3b        |
| Retrieval filtering                  | 1     | qwen2.5:3b        |
| Egyszerű dokumentáció transzformáció | 1     | qwen2.5:3b        |
| JSON normalizálás                    | 1     | qwen2.5:3b        |
| Normál implementáció                 | 2     | Sonnet            |
| Mérsékelt debugging                  | 2     | Sonnet            |
| Multi-file refactor                  | 2     | Sonnet            |
| Normál review                        | 2     | Sonnet            |
| Komplex architektúra                 | 3     | Opus              |
| Nehéz race condition                  | 3     | Opus              |
| Multi-system integration             | 3     | Opus              |
| Új paradigma bevezetése              | 3     | Opus              |

## Local Qwen Role

A `qwen2.5:3b` (HA NUC, 192.168.1.53:11434) elsődleges felelősségei:

1. **classification** -- kategória-besorolás (spam/promo/important, stb.)
2. **routing support** -- melyik agent / skill kezelje az adott inputot
3. **retrieval filtering** -- releváns / irreleváns találatok szétválogatása
4. **summarization** -- hosszú szöveg tömörítése
5. **context compression** -- a cloud modell számára a minimum context összeállítása
6. **relevance ranking** -- top-K találatok sorrendezése
7. **simple transformations** -- JSON parse, formázás, normalizálás
8. **straightforward low-risk tasks** -- ahol a qwen2.5:3b elég

A qwen2.5:3b **NE**:
- Hosszú spekulatív érvelés
- Architektúra döntés
- Komplex debugging
- Race condition analysis

Ha a qwen2.5:3b nem boldogul, escalate formátumot ad vissza:

```yaml
escalate: true
reason: concise explanation
recommended_role: coding | reasoning | architecture | review
required_context:
  - item 1
  - item 2
evidence:
  - relevant evidence
```

## Escalation Path

Ha a LEVEL nem elég:

```
LEVEL 0 fail → próbáld újra más eszközzel, vagy escalate LEVEL 1-be
LEVEL 1 fail → escalate LEVEL 2-be (compact escalation package)
LEVEL 2 fail → escalate LEVEL 3-ba (compact escalation package)
LEVEL 3 fail → BLOCKED + human_input_required
```

Minden escalation **compact** csomaggal történik, NEM a teljes context újraküldésével.

## Context Gate Integráció

A Context Gate a Routing Policy-t használja:

1. TASK indul
2. Determinisztikus search (LEVEL 0: `rg`, `git`, `jq`)
3. Vector retrieval (memory)
4. **Local Qwen relevance filter** (LEVEL 1: `qwen2.5:3b`) -- kiszűri a nem releváns találatokat
5. Minimum context összeállítás (~ 500-2000 token)
6. **Cloud coding** (LEVEL 2: Sonnet) hívás a szűrt context-tel
7. Ha kell, **strong reasoning** (LEVEL 3: Opus) escalation

A Context Gate a `qwen2.5:3b`-t használja a relevance filterhez, NEM a cloud modellt -- ez jelentős token-megtakarítás (a cloud helyett a LAN-on futó Qwen).

## Modell szintek részletezve

### LEVEL 0 -- Deterministic Tool

- Eszközök: `rg`, `grep`, `git`, `jq`, `curl`, `systemctl`, `journalctl`, `pytest`, `npm test`, `find`, `awk`, `sed`, `bash`
- Ezek NEM LLM hívások, hanem parancssori eszközök
- Ingyenes, azonnali, determinisztikus
- **Mindig ezekkel kezdj** -- ha LEVEL 0 megoldja, NE ugorj LEVEL 1-be

### LEVEL 1 -- Local Qwen

- Modell: `qwen2.5:3b` (3.1B, Q4_K_M, 1.9 GB)
- URL: `http://192.168.1.53:11434` (HA NUC Ollama)
- Sebesség: ~ 4-10 tok/s (CPU-only, hideg cache lassabb, meleg gyorsabb)
- Timeout: 90 másodperc (a `QWEN_TIMEOUT_MS` a `src/qwen-router.ts`-ban)
- Prompt: rövid, kategorizáló / szűrő / összegző feladatok
- Output: `escalate: true` csomag, ha nem boldogul

A `qwen2.5:3b` a `src/qwen-router.ts`-on át érhető el (a `DEFAULT_QWEN_MODEL = 'qwen2.5:3b'`).

### LEVEL 2 -- Cloud Coding

- Modell: `claude-sonnet-4-6` (vagy az `ANTHROPIC_DEFAULT_SONNET_MODEL`)
- URL: `ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic` (MiniMax proxy)
- Használat: normál implementáció, mérsékelt debugging, refactor, review
- **Megjegyzés**: a jelenlegi `.env`-ben `ANTHROPIC_MODEL=claude-opus-4-6` van beállítva minden modell-szintre -- ezért a Phase 2-ben egy explicit Sonnet/Opus split kell, hogy a LEVEL 2 tényleg Sonnet legyen, ne Opus

### LEVEL 3 -- Strong Reasoning

- Modell: `claude-opus-4-6`
- Használat: komplex architektúra, nehezen megoldható race condition, multi-system integration
- **SOHA nem default** -- csak ha a LEVEL 2 nem volt elég

## Anti-patterns (NE csináld)

- "Hú, használjuk az Opust, biztos jó lesz" -- pazarlás
- Minden LEVEL 2 hívás egyben LEVEL 3 is -- a Sonnet is elég a legtöbb esetben
- A qwen2.5:3b helyett cloud modell summary / classification -- pazarlás
- A cloud modell használata `rg` / `grep` helyett -- pazarlás
- LEVEL 3 hívás kontextus nélkül -- a Context Gate-et MINDIG használd
- Bonyolult feladatokat közvetlenül a cloud modellnek küldeni Context Gate nélkül

## Ellenőrzés

Minden TASK után:
- `metrics.cloud_model_calls` minimális (TRIVIAL: 0-1, SMALL: 1-3, MEDIUM: 3-10, COMPLEX: 10-30)
- `metrics.strong_model_calls` == 0 (vagy ritka, csak komplex TASK-ra)
- `metrics.local_model_calls` >= `metrics.cloud_model_calls` (ahol lehet)
- A escalation package-ek CONCISERek, nem hosszú leírások

## Buktatók

- A `qwen2.5:3b` összekeverése a Marveen host saját Ollama-jával (ott csak embedding modellek vannak) -- a `OLLAMA_URL` a `.env`-ben a HA NUC-ra mutat
- A HA NUC SSH portja zárva (22) -- az Ollama API portja (11434) viszont él, ezt használjuk
- Ha a qwen-router hívás 90 másodperc után timeout-ot kap, valószínűleg a HA NUC nem elérhető vagy a modell nincs letöltve -- ellenőrizd `curl http://192.168.1.53:11434/api/tags`
- A cloud model hívás előtt MINDIG fusson át a Context Gate (TASK → SEARCH → VECTOR → QWEN FILTER → MIN CONTEXT → CLOUD), különben pazarlás