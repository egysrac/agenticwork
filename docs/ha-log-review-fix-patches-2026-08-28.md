---
name: ha-log-review-fix-patches-2026-08-28
description: Patch-csomag a ha-log-review-fix skillhez — a 2026-08-28-i HA log review/fix work tanulságai. logger.set_level csak session-re él (perzisztens fix: automation + homeassistant start event), entity_registry cleanup auto-fix hatókörbe. Alkalmazd a ~/.claude/skills/ha-log-review-fix/SKILL.md "Buktatók" szekciójára.
type: patch-bundle
source-skill: ha-log-review-fix
source-path: ~/.claude/skills/ha-log-review-fix/SKILL.md
date: 2026-08-28
---

# ha-log-review-fix patches (2026-08-28)

A HA log review/fix work során két konkrét buktatót tanultam, amit a `Buktatók` szekcióhoz kell adni, illetve az "Eljárás" 4. lépését kell bővíteni.

## Patch #1 — logger.set_level csak session-re él (perzisztens fix)

**Trigger:** A `logger.set_level` service hívás csak az aktuális HA session-re csendesíti a loggert. HA újraindításkor a beállítás elvész.

**Mit csináltam (2026-08-28):**
- A `homeassistant.components.http.security_filter` és `http.forwarded` loggert `critical` szintre állítottam
- Két lehetőség van a perzisztens fixre:
  1. **`configuration.yaml`** (NEM érhető el programatikusan File Editor nélkül):
     ```yaml
     logger:
       default: warning
       logs:
         homeassistant.components.http.security_filter: critical
         homeassistant.components.http.forwarded: critical
     ```
  2. **Automation `homeassistant` start event-re** (BÁRHONNAN elérhető API-ból):
     - Trigger: `{platform: "homeassistant", event: "start"}`
     - Action: `logger.set_level` hívás ugyanazzal a kulccsal
     - Ez a HA újraindítása után ismét csendesít
- A második megoldást választottam, mert a File Editor nem volt elérhető programatikusan

**Hova illeszd** a `Buktatók` szekcióba:

```markdown
- **LOGGER.SET_LEVEL CSAK SESSION-RE ÉL (2026-08-28):** a `logger.set_level` service hívás csak az aktuális HA session-re csendesíti a loggert. Perzisztens fixhez két út van: (1) `configuration.yaml` `logger:` szekció (NEM érhető el API-ból, File Editor kell), (2) automation `{platform:"homeassistant", event:"start"}` triggerrel + `logger.set_level` action-nel. A második univerzálisan alkalmazható és bármikor visszavonható az automation törlésével.
```

## Patch #2 — Entity registry cleanup auto-fix hatókör

**Trigger:** Automatizmus-javításkor a HA `_2`, `_3` suffix-szel duplikátum entitásokat készíthet, amik a registry-ben maradnak.

**Mit csináltam (2026-08-28):** Az `automation.elem_lemerules_riasztas` javítása után a registry-ben maradt:
- `automation.elem_lemerules_riasztas` (helyes, működik)
- `automation.elem_lemerules_riasztas_2` (üres, szemét)
- `automation.elem_lemerules_riasztas_3` (üres, szemét)

Ezeket `config/entity_registry/remove` WS-sel töröltem, MIUTÁN a javítás sikeresen lefutott. Tehát ez az auto-fix hatókör része.

**Hova illeszd** az `Eljárás` 4. lépésébe (vagy új 4a alpont):

```markdown
4a. **DUPLIKÁTUM-TÖRLÉS (2026-08-28):** ha a POST-szerkesztés `_2`/`_3` suffix-szel új entitást készített, a registry-ből WS-sel töröld: `{"type":"config/entity_registry/remove","entity_id":"automation.<slug>_2"}` (és ugyanígy `_3`-ra). Az eredeti (suffix nélküli) entitás megmarad.
```

**Plusz a `Buktatók` szekcióba:**

```markdown
- **AUTO-FIX UTÁN REGISTRY-T TAKARÍTANI (2026-08-28):** ha a POST-szerkesztéskor unique_id ütközik és HA csendben új entitást készít `_2`/`_3` suffix-szel, ezeket a javítás UTÁN, de még a session zárása ELŐTT törölni kell a registry-ből (`config/entity_registry/remove`). Különben a duplikátumok "ID already exists" warning-okat generálnak a későbbi POST-oknál.
```

## Alkalmazás

A legegyszerűbb: kézzel beilleszteni a `Buktatók` szekcióba a fenti szövegeket, és a `Eljárás` 4. lépéséhez hozzáadni a 4a alpontot. A skill-futtatáskor a teljes SKILL.md újra beolvasódik, és a buktatók érvényesülnek.

Ha a `~/.claude/skills/` írhatóvá válik (settings.json módosítás vagy `--dangerously-skip-permissions` indítás), ezt a patch-csomagot közvetlenül alkalmazhatod az Edit tool segítségével.
