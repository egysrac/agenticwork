#!/usr/bin/env python3
"""
holadelej_monitor.py — napi elemzés a holadelej.hu oldalról.

Cél: A holadelej.hu design rendszerét és tartalmi struktúráját naponta elemezzük,
hogy Alex HA dashboard stílusához ötleteket merítsünk. A diff az előző napi
snapshot és a mostani között készül; a CSS változók, keyframe-ek, animation-ök,
és új tartalmi blokkok kerülnek kiírásra.

Használat:
    python3 scripts/holadelej_monitor.py fetch    # snapshot + meta + diff
    python3 scripts/holadelej_monitor.py diff     # csak a diff
    python3 scripts/holadelej_monitor.py meta     # csak a meta kiírása
    python3 scripts/holadelej_monitor.py suggest  # skill-javaslatok generálása

Kimenet: store/holadelej-snapshots/YYYY-MM-DD-{html,meta.json} + diff riport stdout.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from collections import Counter
from datetime import date, timedelta
from pathlib import Path

ROOT = Path("/home/alex/marveen")
SNAP_DIR = ROOT / "store" / "holadelej-snapshots"
URL = "https://holadelej.hu/"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"


def fetch_html() -> str:
    """Fetch the page via curl. Returns the HTML text."""
    out = subprocess.check_output(
        ["curl", "-s", "-A", UA, "-L", "--max-time", "20", URL],
        timeout=25,
    )
    return out.decode("utf-8", errors="replace")


def today() -> str:
    return date.today().isoformat()


def yesterday() -> str:
    return (date.today() - timedelta(days=1)).isoformat()


def latest_snapshot_date() -> str | None:
    """Return the most recent baseline-*.html date that is NOT today, or None."""
    today_str = today()
    files = sorted(SNAP_DIR.glob("????-??-??-baseline.html"), reverse=True)
    for f in files:
        m = re.match(r"(\d{4}-\d{2}-\d{2})-baseline\.html", f.name)
        if m and m.group(1) != today_str:
            return m.group(1)
    return None


def extract_meta(html: str) -> dict:
    """Extract structured metadata for diffing."""
    # Title
    title = re.search(r"<title>(.*?)</title>", html, re.I | re.S)
    # Description
    desc = re.search(r'<meta[^>]+name="description"[^>]+content="([^"]+)"', html, re.I)
    # CSS custom properties
    custom_props = re.findall(r"--([a-z0-9-]+)\s*:\s*([^;]+);", html, re.I)
    css_vars = {name: val.strip() for name, val in custom_props}
    # Keyframes defined
    keyframes = sorted(set(re.findall(r"@keyframes\s+([a-z0-9-]+)", html, re.I)))
    # Animations used (in style declarations)
    anims = re.findall(r"animation(?:-name)?\s*:\s*([^;}]+)", html, re.I)
    anims_used = sorted(set(a.strip().split()[0] for a in anims if a.strip()))
    # Counts
    box_shadow = len(re.findall(r"box-shadow\s*:", html, re.I))
    gradients = len(re.findall(r"linear-gradient|radial-gradient|conic-gradient", html, re.I))
    filters = len(re.findall(r"filter\s*:", html, re.I))
    # Layout
    imgs = len(re.findall(r"<img\b", html, re.I))
    buttons = len(re.findall(r"<button\b", html, re.I))
    inputs = len(re.findall(r"<input\b", html, re.I))
    svgs = len(re.findall(r"<svg\b", html, re.I))
    canvases = len(re.findall(r"<canvas\b", html, re.I))
    # Headings
    h1 = len(re.findall(r"<h1\b", html, re.I))
    h2 = len(re.findall(r"<h2\b", html, re.I))
    h3 = len(re.findall(r"<h3\b", html, re.I))
    # Section IDs
    sect_ids = re.findall(r'<(?:section|article)\b[^>]*\bid="([^"]+)"', html, re.I)
    # data-* attributes
    data_attrs = re.findall(r"data-([a-z0-9-]+)\s*=", html, re.I)
    data_counter = Counter(data_attrs)
    # Inline style blocks
    style_blocks = re.findall(r"<style[^>]*>(.*?)</style>", html, re.I | re.S)
    css_size = sum(len(b) for b in style_blocks)
    # Hungarian keywords (tartalmi változás)
    kw = ["MAVIR", "Paks", "MVM", "áram", "fogyaszt", "termel", "import", "export",
          "CO2", "naperőmű", "szél", "Paks", "Duna", "víz", "frekvencia", "rendszer"]
    kw_counts = {k: len(re.findall(rf"\b{k}\b", html, re.I)) for k in kw if k}

    return {
        "size_bytes": len(html),
        "title": title.group(1).strip() if title else None,
        "description": desc.group(1).strip() if desc else None,
        "css_variables": css_vars,
        "css_var_count": len(css_vars),
        "keyframes_defined": keyframes,
        "animations_used": anims_used,
        "box_shadow_count": box_shadow,
        "gradient_count": gradients,
        "filter_count": filters,
        "img_count": imgs,
        "button_count": buttons,
        "input_count": inputs,
        "svg_count": svgs,
        "canvas_count": canvases,
        "headings": {"h1": h1, "h2": h2, "h3": h3},
        "section_ids": sect_ids,
        "data_attrs": dict(data_counter.most_common()),
        "css_size_bytes": css_size,
        "keyword_counts": kw_counts,
    }


def compute_diff(prev: dict, curr: dict) -> dict:
    """Return a structured diff between two meta dicts."""
    diff = {
        "size_delta_bytes": curr["size_bytes"] - prev["size_bytes"],
        "title_changed": prev.get("title") != curr.get("title"),
        "new_css_variables": sorted(set(curr["css_variables"]) - set(prev["css_variables"])),
        "removed_css_variables": sorted(set(prev["css_variables"]) - set(curr["css_variables"])),
        "changed_css_variables": {
            k: {"from": prev["css_variables"][k], "to": curr["css_variables"][k]}
            for k in curr["css_variables"]
            if k in prev["css_variables"] and curr["css_variables"][k] != prev["css_variables"][k]
        },
        "new_keyframes": sorted(set(curr["keyframes_defined"]) - set(prev["keyframes_defined"])),
        "removed_keyframes": sorted(set(prev["keyframes_defined"]) - set(curr["keyframes_defined"])),
        "new_animations_used": sorted(set(curr["animations_used"]) - set(prev["animations_used"])),
        "removed_animations_used": sorted(set(prev["animations_used"]) - set(curr["animations_used"])),
        "layout_delta": {
            "box_shadow": curr["box_shadow_count"] - prev["box_shadow_count"],
            "gradient": curr["gradient_count"] - prev["gradient_count"],
            "filter": curr["filter_count"] - prev["filter_count"],
            "imgs": curr["img_count"] - prev["img_count"],
            "buttons": curr["button_count"] - prev["button_count"],
            "svgs": curr["svg_count"] - prev["svg_count"],
            "canvases": curr["canvas_count"] - prev["canvas_count"],
        },
        "keyword_delta": {
            k: curr["keyword_counts"].get(k, 0) - prev["keyword_counts"].get(k, 0)
            for k in set(curr["keyword_counts"]) | set(prev["keyword_counts"])
            if curr["keyword_counts"].get(k, 0) != prev["keyword_counts"].get(k, 0)
        },
        "new_sections": sorted(set(curr["section_ids"]) - set(prev["section_ids"])),
        "removed_sections": sorted(set(prev["section_ids"]) - set(curr["section_ids"])),
    }
    return diff


def generate_skill_suggestions(diff: dict) -> list[dict]:
    """Generate skill suggestions based on detected changes."""
    suggestions = []
    # New CSS variables → design tokens skill
    if diff["new_css_variables"]:
        for var in diff["new_css_variables"]:
            suggestions.append({
                "category": "design-token",
                "title": f"Új CSS token: --{var}",
                "rationale": f"Új design token jelent meg a holadelej.hu-n. Ha a HA dashboardon hasonló kontextusban kell (pl. severity scale, source accent), érdemes átvenni.",
                "raw_diff": diff["new_css_variables"],
            })
    # New keyframes → animation skill
    if diff["new_keyframes"]:
        for kf in diff["new_keyframes"]:
            suggestions.append({
                "category": "animation",
                "title": f"Új keyframe: @{kf}",
                "rationale": f"Új animáció a referenciában. HA card-modban átvehető, ha vizuálisan passzol.",
                "raw_diff": diff["new_keyframes"],
            })
    # Changed CSS variables → color palette update
    if diff["changed_css_variables"]:
        for var, change in diff["changed_css_variables"].items():
            suggestions.append({
                "category": "color-palette",
                "title": f"Színváltozás: --{var}",
                "rationale": f"Érték változott: {change['from']} → {change['to']}. Alex HA dashboard színskáláját érintheti.",
                "raw_diff": {var: change},
            })
    # Layout delta (canvas, svg) → visualisation skill
    if diff["layout_delta"].get("canvases", 0) > 0:
        suggestions.append({
            "category": "visualization",
            "title": f"Új canvas-alapú vizualizáció ({diff['layout_delta']['canvases']} db)",
            "rationale": "Canvas-alapú custom rajzolás. HA-hoz nehezen átvehető, de mintaként szolgálhat.",
            "raw_diff": diff["layout_delta"],
        })
    # New keyword → new content domain
    if diff["keyword_delta"]:
        for kw, delta in diff["keyword_delta"].items():
            if abs(delta) > 3:
                suggestions.append({
                    "category": "content",
                    "title": f"Tartalmi hangsúlyváltás: {kw} ({'+' if delta > 0 else ''}{delta})",
                    "rationale": f"Az oldal tartalmi fókusza elmozdult a(z) {kw} irányába. HA forrásként is érdekes lehet.",
                    "raw_diff": {kw: delta},
                })
    return suggestions


def cmd_fetch() -> int:
    """Fetch today's snapshot, write meta, and diff against previous."""
    SNAP_DIR.mkdir(parents=True, exist_ok=True)
    print(f"→ Fetching {URL} ...", file=sys.stderr)
    html = fetch_html()
    today_str = today()
    html_path = SNAP_DIR / f"{today_str}-baseline.html"
    meta_path = SNAP_DIR / f"{today_str}-meta.json"
    html_path.write_text(html, encoding="utf-8")
    meta = extract_meta(html)
    meta["date"] = today_str
    meta["url"] = URL
    meta_path.write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"→ Snapshot: {html_path} ({len(html):,} bájt)", file=sys.stderr)
    print(f"→ Meta: {meta_path}", file=sys.stderr)

    # Diff against previous
    prev_date = latest_snapshot_date()
    if prev_date and prev_date != today_str:
        prev_meta = json.loads((SNAP_DIR / f"{prev_date}-meta.json").read_text(encoding="utf-8"))
        diff = compute_diff(prev_meta, meta)
        diff_path = SNAP_DIR / f"{today_str}-diff.json"
        diff_path.write_text(json.dumps(diff, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"→ Diff: {diff_path}", file=sys.stderr)
        # Print human-readable summary
        print("\n=== DIFF vs {} ===".format(prev_date))
        if diff["size_delta_bytes"]:
            print(f"  Méret: {diff['size_delta_bytes']:+} bájt")
        if diff["title_changed"]:
            print(f"  ⚠ Cím változott")
        if diff["new_css_variables"]:
            print(f"  +CSS vars: {diff['new_css_variables']}")
        if diff["removed_css_variables"]:
            print(f"  -CSS vars: {diff['removed_css_variables']}")
        if diff["changed_css_variables"]:
            print(f"  ~CSS vars: {diff['changed_css_variables']}")
        if diff["new_keyframes"]:
            print(f"  +Keyframes: {diff['new_keyframes']}")
        if diff["new_animations_used"]:
            print(f"  +Animations used: {diff['new_animations_used']}")
        if diff["new_sections"]:
            print(f"  +Szekciók: {diff['new_sections']}")
        if diff["removed_sections"]:
            print(f"  -Szekciók: {diff['removed_sections']}")
        ld = diff["layout_delta"]
        nonzero = {k: v for k, v in ld.items() if v != 0}
        if nonzero:
            print(f"  Layout Δ: {nonzero}")
        if diff["keyword_delta"]:
            print(f"  Keyword Δ: {diff['keyword_delta']}")
        if not any([diff["new_css_variables"], diff["changed_css_variables"], diff["new_keyframes"],
                   diff["new_sections"], diff["removed_sections"], nonzero, diff["keyword_delta"]]):
            print("  (nincs strukturális változás)")
    else:
        print("→ Első snapshot, nincs előző az összehasonlításhoz.", file=sys.stderr)
    return 0


def cmd_suggest() -> int:
    """Read latest diff and emit skill suggestions."""
    today_str = today()
    diff_path = SNAP_DIR / f"{today_str}-diff.json"
    if not diff_path.exists():
        print(f"Nincs mai diff: {diff_path}. Futtasd előbb a 'fetch' alparancsot.", file=sys.stderr)
        return 1
    diff = json.loads(diff_path.read_text(encoding="utf-8"))
    suggestions = generate_skill_suggestions(diff)
    out = SNAP_DIR / f"{today_str}-suggestions.json"
    out.write_text(json.dumps(suggestions, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"→ {len(suggestions)} javaslat kiírva: {out}")
    for s in suggestions:
        print(f"  [{s['category']}] {s['title']}")
    return 0


def cmd_meta() -> int:
    """Print the latest meta in pretty format."""
    today_str = today()
    p = SNAP_DIR / f"{today_str}-meta.json"
    if not p.exists():
        print(f"Nincs mai meta: {p}", file=sys.stderr)
        return 1
    meta = json.loads(p.read_text(encoding="utf-8"))
    print(json.dumps(meta, indent=2, ensure_ascii=False))
    return 0


def main() -> int:
    cmds = {"fetch": cmd_fetch, "suggest": cmd_suggest, "meta": cmd_meta}
    if len(sys.argv) < 2 or sys.argv[1] not in cmds:
        print(__doc__)
        return 2
    return cmds[sys.argv[1]]()


if __name__ == "__main__":
    sys.exit(main())
