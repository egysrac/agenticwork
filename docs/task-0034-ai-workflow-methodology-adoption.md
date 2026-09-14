# TASK-0034: AI-fejlesztési munkafolyamat módszertan átvétele (Pintér Zsolt videó, 2026-09-13)

Forrás: https://youtu.be/j96pP8CfyU4 ("Így nem esik szét az AI kódolás közben"),
összefoglalva 2026-09-13 19:46-kor. Alex kérésére a videóban bemutatott 4 pont
(3, 4, 5, 8) részletes kivitelezési terve, alkalmazva a marveen projektre.

Minden terv 3 részből áll: **jelenlegi állapot** (ellenőrizve a repóban),
**cél**, **lépések**.

---

## 3. Dokumentáció mint keret (spec -> plan -> kivitelezés -> teszt-jegyzőkönyv)

### Jelenlegi állapot
- Van ad-hoc konvenció: `docs/task-00XX-<nev>.md` (0031, 0032, 0033) --
  de nincs kikényszerítve, formátuma eltérő taskonként, nincs kötelező
  "teszt-jegyzőkönyv" szakasz.
- Van `decisions/ADR-000X.md` (4 db) architektúra-döntésekre, de ez ritkán
  frissül, nincs kapcsolva a task-briefekhez.
- Nincs `docs/specs/` mappa különálló specifikációkra a kódolás megkezdése
  ELŐTT -- a task-brief-ek visszamenőleg, a munka UTÁN íródnak (post-hoc dok,
  nem tervezési eszköz).
- A kanban rendszer (governance-v1, epic/task briefs) már tartalmaz
  hasonló gondolatot, de fájlszinten nincs egységes séma.

### Cél
Minden nem-triviális (3+ fájlt érintő, vagy retry/timing-logikát módosító)
munka 4 kötelező szakaszt kapjon, egy fájlban vagy egymásra épülő
fájlokban, MIELŐTT a kód elkészül:
1. Spec (mi a probléma, mi a elvárt viselkedés)
2. Terv (milyen lépésekben, milyen fájlokban)
3. Kivitelezés (mi történt ténylegesen -- ez már a jelenlegi task-brief stílus)
4. Teszt-jegyzőkönyv (mivel lett validálva, mi NEM lett tesztelve)

### Lépések
1. `docs/TASK-TEMPLATE.md` létrehozása a 4 kötelező szakasz vázával
   (Spec / Terv / Kivitelezés / Teszt-jegyzőkönyv), a meglévő
   task-0031/32/33 stílusát követve, kiegészítve a hiányzó Spec+Terv résszel.
2. A `governance-kanban-task-pickup` skillbe (már létezik) beszúrni egy
   lépést: kanban kártya felvételekor a sub-agens ELŐSZÖR a Spec+Terv
   szakaszt írja meg és commitolja `docs/task-XXXX-*.md` néven, és csak
   utána kezdi a kódot. (Jelenleg ez a skill a kártya-átvételt kezeli, de
   nem kényszeríti ki a doksi-elsőbbséget.)
3. `feedback_scheduled_task_smoke_test.md` mintájára (meglévő memória-szabály:
   "type:command task módosításakor smoke test kötelező") -- ez már pontosan
   a Teszt-jegyzőkönyv gondolat, csak nincs általánosítva minden taskra.
   Általánosítani: minden `docs/task-XXXX-*.md` kapjon Teszt-jegyzőkönyv
   szakaszt, függetlenül attól, hogy scheduled-task-ot érint-e.
4. A `~/.claude/skills/simplify` és `~/.claude/skills/security-review`
   meglévő skillekhez hasonlóan egy `spec-first` reflex beépítése a
   CLAUDE.md-be: "3+ fájlos vagy retry/timing-logikát érintő módosítás előtt
   írj Spec+Terv szakaszt, ne csak utólag Kivitelezés-t."
5. Ellenőrzés: a következő nem-triviális taskon (pl. a most futó
   DREAMLOOP0912 utótesztje, ha bármi további módosítás kell) próbáljuk ki
   élesben a sablont.

**Kockázat:** ha túl bürokratikussá válik, lassítja az apró javításokat --
ezért a küszöb "3+ fájl VAGY retry/timing-logika", nem minden egysoros fix.

---

## 4. Verziózás kikényszerítése (semver + changelog + GitHub Release, HU+EN)

### Jelenlegi állapot -- **azonnal javítandó hiba található**
- `package.json` verziója: **1.34.1**
- Legutóbbi git tag: **v1.36.0**
- Tehát a `package.json` verziója **2 minor verzióval le van maradva** a
  tag-ektől -- ez pontosan az a fajta drift, amit a videóban bemutatott
  módszer (a modell nézze át az összes commitot és állítson fel
  következetes szabályt) megelőzött volna.
- Nincs `CHANGELOG.md` fájl a repóban egyáltalán, annak ellenére, hogy
  30+ tag van (v1.4.0-tól v1.36.0-ig).
- Van GitHub remote (`github.com/Szotasz/marveen`), tehát Release-ek
  létrehozhatók, de jelenleg nincs bizonyíték, hogy használva lennének.

### Cél
- `package.json` verzió mindig szinkronban a legutóbbi git taggel.
- Minden release-hez `CHANGELOG.md` bejegyzés + GitHub Release, magyarul
  ÉS angolul (a videóban is ez volt Alex-analóg kérése: a szerző külön
  kellett kérje az angol verziót, mi rögtön kétnyelvűként vezessük be).

### Lépések
1. **Azonnali fix:** `package.json` verzióját frissíteni `1.36.0`-ra (vagy
   ha ez a develop ág HEAD-je már túl van rajta, a legfrissebb tag+1 patch-re),
   hogy a drift megszűnjön. Ehhez előbb meg kell nézni, mi történt a
   v1.34.1 -> v1.36.0 közötti tag-ek commit-jaiban (van-e bennük
   `package.json` bump, ami elmaradt a develop merge-nél).
2. `CHANGELOG.md` létrehozása "Keep a Changelog" formátumban, retroaktívan
   feltöltve a `git log --oneline` alapján legalább az utolsó 10 tag-re
   (v1.30.3-tól), előre pedig kötelezővé téve minden jövőbeli release-nél.
3. Egy `scripts/release.sh` segédszkript, ami:
   - beolvassa a legutóbbi tag óta történt commit-okat,
   - felajánl egy patch/minor/major besorolást a conventional-commit
     prefixek alapján (`fix:` -> patch, `feat:` -> minor, `BREAKING` -> major
     -- a repo commit-jai már most is nagyrészt ezt a konvenciót követik,
     lásd `fix(schedule-runner):`, `feat(governance-v1):`),
   - frissíti a `package.json` verziót,
   - beszúr egy `CHANGELOG.md` szakaszt (HU szöveg),
   - lefordítja/generálja az EN szakaszt,
   - `git tag` + push, majd `gh release create` (ha lesz `gh` CLI -- most
     nincs telepítve, lásd Pontok/blokkolók lent).
4. **Blokkoló:** a `gh` CLI jelenleg NINCS telepítve ezen a gépen
   (`which gh` -> nem található). Ehhez a ponthoz szükséges vagy a `gh`
   telepítése, vagy a GitHub REST API közvetlen `curl`-lel hívása
   (`POST /repos/Szotasz/marveen/releases`) egy personal access tokennel --
   ez utóbbi jobban illeszkedik a projekt meglévő szokásához (mindenhol
   REST+curl, nem CLI-eszközök, lásd CLAUDE.md "NE a sqlite3 parancssori
   eszközzel").
5. Ellenőrzés: a legközelebbi valódi fixnél (pl. ha ma éjjel a
   DREAMLOOP0912-höz még kell egy patch) végigfuttatni a teljes láncot és
   ellenőrizni, hogy a tag, a changelog és a package.json verzió mind
   egyezik.

---

## 5. MCP szerverek / pluginek a fejlesztői környezetben

### Jelenlegi állapot -- **teljesen üres**
Ellenőriztem az összes `.mcp.json` fájlt a gépen (jarvis-worker,
jarvis-worker-fast, marveen-worker, telegram-plugin-node-test): mindegyikben
`{"mcpServers": {}}` -- **nincs egyetlen MCP szerver sem konfigurálva**
semelyik ágensnek/worker-nek, a globális `~/.claude.json`-ban is üres a
`mcpServers` lista. A korábbi email/naptár MCP-k (`server-gmail-autoauth-mcp`,
`server-google-calendar-mcp`) máshonnan, feltehetően a saját interaktív
Claude Code session-öm konfigurációjából jönnek, nem a projektszintű
worker-ekéből.

Ez azt jelenti, hogy a háttérben futó ágensek (jarvis-worker, sub-agensek)
jelenleg **nem érnek el semmilyen élő dokumentáció-forrást** (pl. friss
könyvtár-verziók, API-változások) -- pontosan az a probléma, amit a
videóban a Context7 MCP old meg (mindig friss lib-dokumentáció, nem elavult
edzési adat).

### Cél
Legalább a kódoló sub-agensek (jarvis-worker, marveen-worker) kapjanak:
- egy dokumentáció-friss MCP-t (Context7-szerű, vagy ha az nem elérhető
  ebben a környezetben, a meglévő WebFetch/WebSearch-öt kötelező lépésként
  beírni skillekbe könyvtár-verzió kérdéseknél),
- egy biztonsági szkennelést (pl. `npm audit` már fut manuálisan --
  memória szerint van `chore/npm-audit-fix-safe` branch is -- ezt lehetne
  MCP/hook szintre emelni, ne csak alkalmi branch legyen).

### Lépések
1. Felmérni, milyen MCP szerverek ÉRHETŐK EL ebben a hosztolt környezetben
   (nem minden nyilvános MCP fut korlátok nélkül egy Linux szerveren API
   kulcs / hálózati hozzáférés nélkül) -- ehhez ki kell deríteni, van-e
   Context7 API-kulcs vagy hasonló, vagy csak a publikus, kulcs nélküli
   verziója használható.
2. `.mcp.json` sablon létrehozása a worker-eknek (`~/.jarvis-worker/.mcp.json`,
   `~/.marveen-worker/.mcp.json`) legalább egy dokumentáció-MCP-vel, ha
   elérhető ingyenesen/kulcs nélkül.
3. Ha MCP-szinten nem megoldható (hálózati/API-kulcs korlát miatt), akkor
   ez a pont **skill-szintre** essen vissza: minden kódoló skill/task-brief
   kapjon egy kötelező "ellenőrizd a friss dokumentációt WebFetch/WebSearch-
   csel, mielőtt egy külső könyvtárat használsz" lépést -- ez gyengébb, mint
   egy valódi MCP, de a jelenlegi (nulla) állapotnál jobb.
4. `npm audit` heti/release-enkénti kötelező lépéssé tétele a
   `scripts/release.sh`-ban (lásd 4. pont), nem csak alkalmi branch-ként.
5. Ellenőrzés: egy tesztfeladatban (pl. egy npm csomag frissítése) mérjük,
   hogy a sub-agens ténylegesen a friss dokumentációt használta-e, nem a
   betanítási adatból származó elavultat.

**Fontos korlát, amit tisztázni kell Alex-szel:** ez a pont a legkevésbé
kontrollált -- nem tudom garantálni MCP-szintű megoldást, amíg nem derül ki,
elérhető-e itt egy ilyen szolgáltatás API-kulcs/hálózat nélkül. Ezt a
kivitelezés előtt jóvá kell hagyatni.

---

## 8. Fork/PR-integráció mint biztonságos munkamódszer

### Jelenlegi állapot
- A projekt MÁR ERŐSEN branch/worktree-alapú: 16+ aktív git worktree
  (`marveen-task0032`, `marveen-wt-task19`, `marveen-wt-task21`,
  `marveen-wt-task23`, `marveen-hermes-gov`, `marveen-hermes-baseline`, stb.)
  és tucatnyi remote branch (`feat/*`, `chore/*`, `docs/*`, `draft/*`).
  Tehát az izolált-branch-ben-dolgozás infrastruktúrája megvan.
- **DE nincs formalizált "teszteld izoláltan, csak utána merge-eld vissza"
  védőháló** -- ezt bizonyítja a nemrég (2026-09-13) valóban megtörtént
  incidens: a DREAMLOOP0912 fix bekerülése közben egy PÁRHUZAMOSAN futó
  másik ágens (TASK-0032 munka) UGYANAZT az élő checkout-ot szerkesztette,
  és véletlenül visszaállította a fixet a régi, hibás állapotára, majd egy
  build ezzel a hibás állapottal futott le -- anélkül, hogy bárki azonnal
  észrevette volna. Ez pontosan az a kockázat, amit a videóban bemutatott
  "izolált branch -> commit+diff összevetés -> csak a végeredmény megy
  vissza a fő ágba" módszer megelőz.
- `gh` CLI nincs telepítve, tehát a valódi GitHub PR-alapú review (kommentek,
  CI-check, "squash and merge" gomb) jelenleg nem elérhető parancssorból --
  a meglévő munkamódszer közvetlen push/merge a develop ágra.

### Cél
Minden olyan helyzetben, ahol **több ágens egyszerre nyúlhat ugyanahhoz a
fájlhoz** (pontosan ez történt a DREAMLOOP0912 esetben), legyen kötelező:
1. Saját worktree/branch,
2. A célágból (develop) friss `diff`/`merge-base` összevetés a saját
   branch-csel MIELŐTT commit,
3. Csak `git merge --ff-only` (vagy explicit konfliktus-kezelés) a fő
   checkout-ba, SOHA nem közvetlen szerkesztés az élő `/home/alex/marveen`
   checkout-ban párhuzamos munka mellett.

Ez már **részben dokumentált szabály** (`reference_main_checkout_commit_block.md`
memória: "Fő checkout commit-blokkoló hook... worktree+ff-merge a helyes
út"), de a DREAMLOOP0912 incidens azt mutatja, hogy ez nem volt elég
kikényszerítve minden ágens számára minden esetben.

### Lépések
1. **Gyökér-fix:** egy pre-commit vagy pre-push hook a fő
   `/home/alex/marveen` checkout-ban, ami FIGYELMEZTET (vagy blokkol), ha a
   commit előtti `git status` szerint módosult fájlok között olyan van,
   amit egy másik, jelenleg is futó ágens (más tmux session / más worktree)
   is módosított az utolsó N percben -- ehhez a `task_runs`/agent-taskstate
   API-ból lehet lekérdezni, mely ágensek aktívak és mit módosítanak.
2. A `governance-kanban-task-pickup` és `team-four-eyes-review` skillek
   kiegészítése egy explicit lépéssel: mielőtt egy ágens a FŐ checkout-ban
   (nem saját worktree-ben) módosít egy fájlt, ellenőrizze a kanban táblán,
   fut-e másik kártya ugyanazon a fájlon/modulon.
3. A "fork-integráció mint teszt" gondolat közvetlen átvétele: amikor egy
   sub-agens PR-szerű módosítást hoz létre (saját worktree-ben kész munka),
   a fő checkout-ba integráló lépés legyen mindig:
   `diff` a `develop`-hoz képest -> automatikus teszt (npm test / tsc) a
   worktree-ben -> csak utána `git merge --ff-only` a fő checkout-ba.
   Ez gyakorlatilag már a DREAMLOOP0912 commit során alkalmazott módszer
   volt (worktree-ben tesztelve, utána ff-merge) -- ezt kellene szabállyá
   tenni MINDEN nem-triviális módosításra, nem csak azért, mert ez esetben
   már megégtünk.
4. Mivel nincs `gh` CLI és valós PR-folyamat, fontolóra venni: érdemes-e
   ezen a ponton bevezetni a `gh` CLI-t és tényleges GitHub PR-okat
   (branch -> PR -> saját review -> merge), vagy a jelenlegi
   worktree+ff-merge módszer elég-e. Ez Alex döntése -- a PR-alapú út
   auditálhatóbb (GitHub felületen látható history, kommentelhető), de
   plusz lépés minden módosításnál.

**Kockázat/nyitott kérdés Alex felé:** a `gh` CLI hiánya blokkolja a
tényleges GitHub Release-eket (4. pont) ÉS a valódi PR-workflow-t (8. pont).
Ha ezt a két pontot komolyan be akarjuk vezetni, a `gh` CLI telepítése
(`sudo apt install gh` vagy hasonló) az első lépés -- ezt jóvá kell hagyni,
mert rendszerszintű csomagtelepítés.

---

## Összefoglaló prioritási sorrend (javaslat)

1. **4. pont azonnali resze**: `package.json` verzió-drift javítása (1.34.1 ->
   valós) -- ez egy 5 perces, kockázatmentes fix, érdemes külön, azonnal
   elvégezni, nem várni rá.
2. **8. pont**: a DREAMLOOP0912-hez hasonló jövőbeli incidensek megelőzése --
   ez a legmagasabb kockázatcsökkentésű pont, mert MÁR OKOZOTT éles hibát.
3. **3. pont**: spec-first sablon bevezetése -- közepes erőfeszítés, közepes
   haszon, jól illeszkedik a meglévő task-brief szokáshoz.
4. **5. pont**: MCP-dokumentáció-frissesség -- ez a legbizonytalanabb
   (külső függőség, API-kulcs kérdés), ezért utolsó, és jóváhagyást igényel
   mielőtt bármi konkrét telepítés történne.

Egyik pontban sincs még kód írva vagy commit -- ez tisztán tervezési
dokumentum, Alex jóváhagyására vár a végrehajtás megkezdése előtt.
