---
name: ha-automation-edit-patches-2026-08-28
description: Patch-csomag a ha-automation-edit skillhez — a 2026-08-28-i HA log review/fix work tanulságai. POST unique_id az URL-ben, entity_registry/remove WS duplikátum-törléshez. Alkalmazd a ~/.claude/skills/ha-automation-edit/SKILL.md "Buktatók" szekciójára.
type: patch-bundle
source-skill: ha-automation-edit
source-path: ~/.claude/skills/ha-automation-edit/SKILL.md
date: 2026-08-28
---

# ha-automation-edit patches (2026-08-28)

A HA log review/fix work során két konkrét buktatót tanultam, amit a `Buktatók` szekcióhoz kell adni.

## Patch #1 — POST unique_id az URL-ben, NE a body-ban

**Trigger:** Új automatizmus POST-olásánál a body-ban lévő `id` mező csendben duplikátumot készít.

**Mit csináltam (2026-08-28):** Az `automation.elem_lemerules_riasztas` javítása során:
- A numerikus unique_id (`1785158097407`) az URL-be került: `POST /api/config/automation/config/1785158097407`
- A body-ból az `id` mező KI volt véve
- Ellenkező esetben HA csendben új automationt készített (mert a POST a slug-os URL-re ment és nem létező ID-t talált), és "ID already exists" warning maradt a logban
- 2 ilyen duplikátum (`_2`, `_3`) keletkezett, és `config/entity_registry/remove` WS-sel kellett törölni

**Hova illeszd** a `Buktatók` szekcióba:

```markdown
- **POST UNIQUE_ID AZ URL-BEN, NE A BODY-BAN (2026-08-28):** új automatizmus POST-jánál a numerikus unique_id az URL-be kerül (`POST /api/config/automation/config/<id>`), a body-ból az `id` mező KI kell venni. Különben HA csendben új automationt készít és "ID already exists" warning marad. A duplikátum ilyenkor `_2`, `_3` suffix-szel jön létre, és külön `config/entity_registry/remove` WS-sel kell törölni (lásd lentebb).
```

## Patch #2 — entity_registry/remove WS duplikátum-törléshez

**Trigger:** POST-szerkesztéskor `_2`, `_3` suffix-szel duplikátum automation keletkezett, és a registry-ből kell törölni.

**Mit csináltam (2026-08-28):** Miután a javítás sikeresen lefutott, a registry-ben maradt 2 használaton másolat:
- `automation.elem_lemerules_riasztas_2` és `_3`
- Törlés WS-sel: `{type: "config/entity_registry/remove", entity_id: "automation.elem_lemerules_riasztas_2"}`
- A `_2` és `_3` slug-ok suffix-ét a HA automatikusan adja, ha a unique_id ütközik

**Hova illeszd** a `Buktatók` szekcióba:

```markdown
- **ENTITY_REGISTRY/REMOVE DUPLIKÁTUM-TÖRLÉS (2026-08-28):** ha POST-szerkesztéskor a unique_id ütközik és HA `_2`/`_3` suffix-szel új entitást készít, a duplikátumot WS-sel kell törölni a registry-ből: `{"type":"config/entity_registry/remove","entity_id":"automation.<slug>_2"}`. Az eredeti entitás (suffix nélkül) megmarad.
```

## Alkalmazás

A legegyszerűbb: kézzel beilleszteni a `Buktációk` szekcióba a fenti szövegeket. A skill-futtatáskor a teljes SKILL.md újra beolvasódik, és a buktatók érvényesülnek.

Ha a `~/.claude/skills/` írhatóvá válik (settings.json módosítás vagy `--dangerously-skip-permissions` indítás), ezt a patch-csomagot közvetlenül alkalmazhatod az Edit tool segítségével.
