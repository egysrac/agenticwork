# TASK-0035: Obsidian Second Brain -- 2. videó kiegészítés a meglévő tervhez

Forrás: https://youtu.be/b4d32pBa3UY ("This AI System Will Make You So Smart
It's Almost Unfair", Dan Martell, 12:02, feltöltve 2026-06-25). Feldolgozva
2026-09-13 22:xx-kor, magyar felirat helyett angol auto-sub letöltve
yt-dlp-vel (a csatorna nem ad magyar feliratot).

Ez a doksi a MEGLÉVŐ kanban kártya (`88810d44`, "Obsidian Second Brain + PARA
+ MCP telepítés", 18 lépés, 5 fázis, lásd `project_obsidian_para_plan_2026_09_08`
memória) KIEGÉSZÍTÉSE, nem helyettesítése. A régi terv 2 nyitott döntésen
(D1, D2) állt, azóta nincs válasz -- ez most 3 újabbat ad hozzá (D3-D5).

---

## Mit ad hozzá ez a videó a meglévő tervhez

A videó szerzője (Dan Martell) egy saját "AI brain" rendszert épített, ami
4 pilléren áll:

1. **Identitás-fájlok** -- `user.md` (ki vagy, hogyan kommunikálsz),
   `soul.md` (milyen hangnemet vegyen fel az AI), `identity.md` (mi az AI
   szerepe/neve). Javasolt módszer: ne magad írd meg, hanem az AI
   interjúvoljon ki téged, és ő írja meg a 3 fájlt.
2. **Mappa-struktúra** -- 7+1 mappa: `people/`, `projects/`, `decisions/`,
   `companies/`, `meetings/`, `daily/`, `knowledge/`, plusz egy `MOC`
   (Maps of Content) mappa, ami Dataview-lekérdezésekkel összefésült
   index-fájlokat tartalmaz. **Ez ELTÉR a már eldöntött PARA-struktúrától**
   (Projects/Areas/Resources/Archives) -- ütközés, amit tisztázni kell.
3. **Meeting-feldolgozás** -- meetingek automatikus transzkripciója és
   kivonatolása (döntések, vállalások, preferenciák, insight-ok) markdown
   fájlba. A videóban használt eszköz: **Grainola** (helyesen: **Granola**,
   egy fizetős SaaS AI-jegyzetelő).
4. **Éjszakai "compounding"** -- minden este egy automatizált cron-feladat
   végigfésüli a vaultot: árva jegyzeteket köt be, duplikátumokat összevon,
   MOC-okat frissít, stratégiai pontokat megjelöl reggelre.

---

## Alternatívák, amiket kerestem (WebSearch, 2026-09-13)

### Granola helyett -- self-hosted opciók
A videó fizetős, felhő-alapú SaaS-t (Granola) használ a meeting-feldolgozásra.
Alex korábbi preferenciái alapján (OSM Overpass API bypass a fizetős
keresés helyett, Faster Whisper említése az előző videós feladatban) egy
**helyi, ingyenes** alternatíva jobban illeszkedik:

| Eszköz | Licenc | Jellemző |
|---|---|---|
| **Anarlog** | MIT (Rust+Tauri) | Helyi transzkripció, markdown export közvetlenül fájlba -- legközelebb áll a "canonical local markdown" elváráshoz |
| **Meetily** | MIT (community edition) | Windows/macOS/Linux, Whisper VAGY Parakeet helyi ASR, semmi nem megy külső szerverre |
| **OpenWhispr** | nyílt forrás | Helyi pipeline, helyi beszélő-diarizáció |

A marveen gépen már megvan az `ffmpeg` (alap függőség), tehát egy
Whisper-alapú helyi pipeline technikailag nem jelent új infrastruktúrát.

Forrás: [5 Best Open Source Granola Alternatives in 2026](https://openalternative.co/alternatives/granola),
[Granola Alternative — Local, Open Source AI Meeting Notes](https://openwhispr.com/compare/granola),
[Meetily — free open-source self-hosted AI meeting note taker](https://dev.to/zackriya/meetily-the-best-free-open-source-self-hosted-ai-meeting-note-taker-a-granola-alternative-for-2c8e)

### Obsidian helyett -- csak tájékoztatásul
Mivel a MEGLÉVŐ terv (kanban 88810d44) már Obsidiant választotta (Smart
Connections + mcpvault + ob-smart-connections-mcp mind Obsidian-specifikus),
**nem javaslom a váltást** -- ez a videó is Obsidiant ajánlja "ha a next
level kell". Csak arra az esetre dokumentálom, ha D1 (melyik gépen fusson)
miatt Obsidian mégsem telepíthető a célgépen:

| Eszköz | Licenc | Miért releváns / miért nem |
|---|---|---|
| **Logseq** | nyílt forrás | Helyi markdown fájlok, blokk-alapú outliner+graph -- legközelebbi Obsidian-analóg, de más szerkesztési modell (blokk vs. szabad szöveg) |
| **Anytype** | nyílt forrás | Helyi-first, végpontok-közötti titkosítás, peer-to-peer szinkron -- DE típusos objektumok, NEM sima markdown fájlok, ez gyengíti az "bármely AI olvassa a markdown-t" elvet |
| **Joplin** | nyílt forrás | E2E titkosítás minden sync-providerrel |

Forrás: [15 Obsidian Alternatives 2026](https://www.toolworthy.ai/blog/obsidian-alternatives),
[Best Obsidian alternatives in 2026: AI-native, local-first, open-source](https://froots.ai/blog/obsidian-alternatives-2026)

---

## Bevezetési terv -- 3 új fázis a meglévő 5 fázishoz

A kanban 88810d44 terve Fázis 1-5-ig tart (Obsidian+vault -> core pluginok
-> mcpvault MCP -> smart-connections MCP -> verifikáció). Ez a videó 3
további fázist indokol:

**Fázis 6 -- Identitás-fájlok**
19. `user.md`, `soul.md`, `identity.md` generálása -- a videó módszere
    szerint egy AI-interjú Alex-szel (ki vagy, kommunikációs stílus,
    elvárások), amiből a 3 fájl megíródik.
20. **Nyitott döntés (D3):** ez a Jarvis CLAUDE.md "Személyiség" +
    "Felhasználói profil" szekcióinak KIBŐVÍTÉSE legyen, vagy egy ÚJ,
    önálló second-brain-identitás (más AI, más célra, mint Jarvis)?

**Fázis 7 -- Mappa-struktúra reconciliáció**
21. **Nyitott döntés (D4):** a már eldöntött PARA VAGY a videó 7 mappája
    (people/projects/decisions/companies/meetings/daily/knowledge+MOC)
    legyen az elsődleges, vagy hibrid (pl. `people/` és `companies/` a
    PARA `Areas/` alá kerül, `knowledge/` a `Resources/` alá)?
22. MOC-fájlok bevezetése Dataview-lekérdezésként -- ez a Fázis 2-ben már
    tervezett Dataview plugint használja, nincs új függőség.

**Fázis 8 -- Meeting-feldolgozás + éjszakai automatizmus**
23. **Nyitott döntés (D5):** melyik self-hosted meeting-transzkripciós
    eszköz (Anarlog / Meetily / OpenWhispr) a 3 közül?
24. Egyedi extrakciós prompt beállítása (a videóból átvehető váz): döntések
    / vállalások / preferenciák / insight-ok kivonatolása markdown-ba, a
    `meetings/` mappába, `ÉÉÉÉ-HH-NN-meeting-nev.md` névvel.
25. Éjszakai "compounding" cron -- **ez szó szerint ugyanaz a minta, mint a
    marveen `dream-engine` schedule** (01:02-kor fut, jegyzeteket ír,
    konszolidál). NEM kell új infrastruktúra: a meglévő schedule-runner
    (`~/.claude/scheduled-tasks/` + `/api/schedules`) simán megvalósítja,
    FELTÉVE hogy D1 (melyik gép) szerint a vault olyan helyen van, ahol a
    schedule-runner el is éri (helyi fájlrendszer, nem egy külön asztali gép
    hálózati elérés nélkül).

---

## Összes nyitott döntés (2 régi + 3 új)

| # | Kérdés | Státusz |
|---|---|---|
| D1 | Melyik gépen fusson az Obsidian desktop app? | NYITOTT (2026-09-08 óta) |
| D2 | MCP-k a Jarvis-Claude kliensbe vagy külön kliens? | NYITOTT (2026-09-08 óta) |
| D3 | Identitás-fájlok a CLAUDE.md-t bővítik, vagy önálló second-brain-identitás? | ÚJ |
| D4 | PARA vagy a videó 7-mappás rendszere, vagy hibrid? | ÚJ |
| D5 | Melyik self-hosted meeting-transzkripciós eszköz? | ÚJ |

Végrehajtás itt sem indult -- ez is tisztán terv, Alex 5 nyitott döntésére
vár mindkét videó együttes tartalma alapján.
