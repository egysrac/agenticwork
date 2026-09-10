# Feladat: 71 upstream commit telepítése

Ezt Alex rád bízta (2026-09-04): „Ha ezt tudja Marveen csinálni, akkor végezze el
ő, vegye fel a saját kanban listájára." Vedd fel kanban-kártyaként, és te
vezényeld le. Alex nem akarja kézből csinálni.

## Mi ez

A `~/marveen` repo (ág: **`develop`**, verzió 1.34.1) **71 committal van lemaradva**
az `origin/develop` mögött, és **21 helyi commit** van előtte.

Figyelem: az alapértelmezett ág **`develop`**, nem `main`. Egy korábbi mérésem
azért mutatott tévesen „nincs lemaradást", mert `origin/main`-hez hasonlítottam.

## Miért fontos

Van a lemaradásban egy commit, ami közvetlenül minket érint:

```
5c9a925 fix(memory): generate embedding in saveMemory too, with a test that
        actually guards it (#1168)
```

Ez **pontosan az a beágyazás-hiba, amit 2026-08-19-én kézzel javítottunk**
(146 memória újraszámolása 384 → 768 dimenzióra, mert a szemantikus keresés
némán kihagyta a memóriák 71%-át). Az upstream most a **gyökerét** javította
meg, és tesztet is tett mellé, ami őrzi. Amíg ez nincs bent, a hiba
visszatérhet minden új memóriánál.

Rajta kívül legalább két, erre a gépre releváns javítás:
- `f7aa344 fix(email-gate)` — a jóváhagyó kapu olyan SQL-t futtatott, amit az
  élő hoszt SQLite-ja nem tud értelmezni
- `9d3b77f fix(start,stop)` — idempotens indítás Linuxon, és olyan leállítás,
  ami megvárja a tényleges kilépést

## Mikor

**Ne ma (2026-09-04).** Ma három nagy változás történt ezen a gépen:
1. a motor MiniMax-M3-ról **Claude**-ra (`claude-sonnet-5`),
2. a Claude Code **2.1.110**-re rögzítve, auto-frissítés kikapcsolva,
3. a WiFi a jó AP-ra (`A8:5E:45:4F:7C:C8`) kötve.

Hagyj **egy nap együttfutást**. Ha most jönne rá egy 71 commitos frissítés és
holnap elromlik valami, nem lenne eldönthető, melyik változás okozta.
**Legkorábban 2026-09-05.**

## Hogyan — négy-szem elv (Alex állandó szabálya)

1. **Előtte:** mentés, és írd ki a 21 helyi commit listáját, hogy utána
   ellenőrizhető legyen, mind megvan-e.
2. Rebase `origin/develop`-ra.
3. `npm ci` + `npm run build` + `npm test` (vitest) + `npx tsc --noEmit`.
4. **Célzott éles próba** azokra a commitokra, amik futó viselkedést érintenek
   (ütemező, híd, hookok, ágens-indítás) — **valós hívással, nem
   feltételezéssel**. Egy futó rendszer önmagában nem bizonyíték: a
   háttérfeladat-hiba öt napig észrevétlen volt, mert véletlenül működőnek
   látszott.
5. **Weinberg függetlenül** ellenőrzi a kockázatosakat a saját protokollja
   szerint (terv → más modellel felülvizsgáltat → végrehajt → bizonyít).
   Használhatja a `scripts/ask-model.sh`-t.
6. A két eredményt vesd össze, és **az eltéréseket mondd ki Alexnek** — az
   eltérés önmagában információ.

## Amire külön figyelj

- **Az Atom CPU-ban NINCS AVX.** A Claude Code marad 2.1.110-en, az
  auto-frissítés három úton ki van kapcsolva (`~/.claude/settings.json`,
  `bridge.py`, `marveen-main-session.sh`). **Ezt ne bontsd meg** — a 2.1.260
  már csak natív binárist szállít, és azonnal SIGILL-lel elszáll.
- A `.env`-ben az `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` **szándékosan**
  `MINIMAX_*` néven van (mert Claude-motoron megyünk, és az `agent-process.ts`
  ezekből építené a MiniMax-környezetet). **Ne nevezd vissza.**
- **Helyi javítások, amiknek túl kell élniük a rebase-t:**
  `bridge.py`; `marveen-watchdog.sh` (session-pótlás az internet-kapu **előtt**
  + `wifi-pin-guard` hívás); `marveen-parked-prompt-guard.sh`;
  `scripts/send-morning.py` frissesség-ellenőrzés; `agent-process.ts`
  `isMiniMax` ág; `background-tasks.ts` három javítása; `gmail-api.ts`
  boríték-javítás.
- **Az éles fán a commitot Alex futtatja** (`MARVEEN_PROD_COMMIT_OK` guard).
  Ezt ne kerüld meg.

## Mikor kész

Akkor, ha: a build és a tesztek futnak; mind a 21 helyi javítás **bizonyítottan**
megvan; Weinberg független köre lezárult; és a `~/JARVIS-CHANGELOG.md`-ben van
róla bejegyzés.
