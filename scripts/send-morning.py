#!/usr/bin/env python3
"""06:00-kor küldi a /home/alex/marveen/MORNING.md tartalmát Telegramra.

A reggeli-napindito (dream-engine típus, 02:07) készíti elő a fájlt, ez a
script csak beolvassa és elküldi. Ha a fájl nem létezik vagy üres, riasztást
küld és exit 1.

A command típusú scheduled task ezt a scriptet futtatja LLM nélkül, tehát
nincs MiniMax-M3 context-probléma.
"""
from __future__ import annotations

import datetime
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

MORNING_FILE = Path("/home/alex/marveen/MORNING.md")
SENT_FILE = Path("/home/alex/marveen/store/.morning-last-sent")
ENV_FILE = Path("/home/alex/marveen/.env")
CHAT_ID = "8930438924"
MAX_CHUNK_CHARS = 3500  # 4096 alatt, hogy kimaradjon az escape-számítás
# MarkdownV2 escape-karakterek a Telegram docs szerint:
#   _ * [ ] ( ) ~ ` > # + - = | { } . ! \
# A `*` jelet CSAK páros `*...*` formában hagyjuk escape nélkül (félkövér).
# A regex karakterosztályban a `]` CSAK az első karakterként (a nyitó `[` után)
# literál -- különben ZÁRÓJELEKÉNT viselkedik, és a karakterosztály a `_` után
# bezárul. Ezért a `]` a karakterosztály ELEJÉN van.
MD_V2_CODE = re.compile(r"`[^`\n]+`")
MD_V2_DOUBLE_BOLD = re.compile(r"\*\*([^*\n]+)\*\*")
MD_V2_BOLD = re.compile(r"\*[^*\n]+\*")
MD_V2_ESCAPE_CHARS = r"\][_()~`>#+\-=|{}.!\\"


def get_token() -> str:
    with ENV_FILE.open() as f:
        for line in f:
            if line.startswith("TELEGRAM_BOT_TOKEN="):
                return line.split("=", 1)[1].strip()
    raise SystemExit("TELEGRAM_BOT_TOKEN not found in /home/alex/marveen/.env")


def escape_markdown_v2(text: str) -> str:
    """Escape MarkdownV2 special chars, preserving *...* bold pairs.

    A `*...*` párok tartalmát IS escape-elni kell (pl. `*Jarvis, 10:30 — smoke test.*`
    végén a `.`), mert a visszahelyettesítés után a tartalom újra megjelenik, és
    a külső re.sub már lefutott. A _stash a tartalmat (a `*` jelek nélkül) már
    escape-elve menti.

    A dream-engine (LLM) gyakran a szokásos Markdown `**bold**` (dupla csillag)
    konvenciót írja a MORNING.md-be, de a Telegram MarkdownV2 csak az egyszeres
    `*bold*` formát ismeri. A dupla csillagos regex csak az egyik csillagpárt
    fogta be korábban, a másik pár egy-egy magányos, escape nélküli `*`-ot
    hagyott hátra, ami "Can't find end of Bold entity" hibával elutasításhoz
    vezetett (2026-09-06 reggeli-monitor riasztás, byte offset 3387). Ezért a
    dupla csillagot MINDIG normalizáljuk egyszeresre, mielőtt a bold-regex lefut.

    Egy MÁSODIK, ugyanabból az incidensből felszínre került eset: egy
    backtick-es inline kód (pl. cron kifejezés ``7 2 * * *``) belsejében lévő
    csillagok is a bold-regex elé kerülhetnek, és mivel a csillagok száma
    páratlan (3 db), a regex csak az elsőt párosítja, a harmadik magányos
    marad -- ugyanaz a "Can't find end of Bold entity" hiba. Ezért a
    backtick-es kódrészeket a bold-matching ELŐTT kiemeljük (stash), hogy a
    bennük lévő csillagok ne keveredjenek a bold-párosításba.
    """
    saved_code: list[str] = []

    def _stash_code(match: re.Match) -> str:
        inner = match.group(0)[1:-1]  # tartalom a backtick jelek nélkül
        # Telegram spec: kódrészben csak a `\` és a backtick igényel escape-et.
        inner_escaped = inner.replace("\\", "\\\\").replace("`", "\\`")
        saved_code.append(f"`{inner_escaped}`")
        return f"\x00CODE{len(saved_code) - 1}\x00"

    text = MD_V2_CODE.sub(_stash_code, text)
    text = MD_V2_DOUBLE_BOLD.sub(r"*\1*", text)
    saved: list[str] = []

    def _stash(match: re.Match) -> str:
        inner = match.group(0)[1:-1]  # tartalom a `*` jelek nélkül
        inner_escaped = re.sub(f"([{MD_V2_ESCAPE_CHARS}])", r"\\\1", inner)
        saved.append(f"*{inner_escaped}*")
        return f"\x00BOLD{len(saved) - 1}\x00"

    text = MD_V2_BOLD.sub(_stash, text)
    text = re.sub(f"([{MD_V2_ESCAPE_CHARS}])", r"\\\1", text)
    for i, original in enumerate(saved):
        text = text.replace(f"\x00BOLD{i}\x00", original)
    for i, original in enumerate(saved_code):
        text = text.replace(f"\x00CODE{i}\x00", original)
    return text


def send(text: str) -> bool:
    escaped = escape_markdown_v2(text)
    data = urllib.parse.urlencode(
        {"chat_id": CHAT_ID, "text": escaped, "parse_mode": "MarkdownV2"}
    ).encode("utf-8")
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{TOKEN}/sendMessage", data=data
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read())
            if not result.get("ok"):
                sys.stderr.write(f"send failed: {result}\n")
                return False
            return True
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        sys.stderr.write(f"send HTTP {e.code}: {body}\n")
        return False
    except Exception as e:
        sys.stderr.write(f"send exception: {e}\n")
        return False


def split_into_chunks(content: str) -> list[str]:
    """Split at newline boundaries so each chunk stays under MAX_CHUNK_CHARS."""
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for line in content.split("\n"):
        line_len = len(line) + 1  # +1 for newline
        if current and current_len + line_len > MAX_CHUNK_CHARS:
            chunks.append("\n".join(current))
            current = [line]
            current_len = line_len
        else:
            current.append(line)
            current_len += line_len
    if current:
        chunks.append("\n".join(current))
    return chunks


def main() -> int:
    if not MORNING_FILE.exists():
        msg = (
            f"\u26a0\ufe0f Reggeli jelent\u0151 NEM k\u00e9sz\u00fclt el: "
            f"`{MORNING_FILE}` nem l\u00e9tezik. A 02:07-es el\u0151k\u00e9sz\u00edt\u00e9s "
            f"nem futott le, vagy nem \u00edrta ki a f\u00e1jlt. N\u00e9zd meg a "
            f"`reggeli-napindito` task run history-j\u00e1t a dashboardon."
        )
        send(msg)
        return 1

    try:
        content = MORNING_FILE.read_text(encoding="utf-8").strip()
    except Exception as e:
        send(f"\u26a0\ufe0f Reggeli jelent\u0151 olvas\u00e1si hiba: `{e!s}`")
        return 1

    if not content:
        send(
            f"\u26a0\ufe0f Reggeli jelent\u0151 NEM k\u00e9sz\u00fclt el: "
            f"`{MORNING_FILE}` \u00fares."
        )
        return 1

    # --- FRISSESSEG-ELLENORZES (2026-09-04) --------------------------------
    # A letezes- es uresseg-ellenorzes nem fogja meg azt az esetet, amikor a
    # generalo fele elhal, a kuldo fele viszont tovabb fut: ilyenkor napokon at
    # ugyanaz a regi fajl megy ki, es minden "mukodonek" latszik. 2026-09-02 es
    # 09-04 kozott pontosan ez tortent. A tartalmat tovabbra is elkuldjuk, de a
    # regiseget lehetetlen ne eszrevenni.
    file_day = datetime.date.fromtimestamp(MORNING_FILE.stat().st_mtime)
    today_d = datetime.date.today()
    if file_day != today_d:
        kor = (today_d - file_day).days
        content = (
            f"\u26a0\ufe0f *FIGYELEM: ez a jelentes NEM mai.* "
            f"A MORNING.md {file_day.isoformat()}-i, {kor} napja keszult. "
            f"A 02:07-es reggeli-napindito azota nem futott le, "
            f"ezert az alabbi tartalom REGI.\n\n"
        ) + content

    chunks = split_into_chunks(content)
    for i, chunk in enumerate(chunks, 1):
        ok = send(chunk)
        if not ok:
            sys.stderr.write(
                f"chunk {i}/{len(chunks)} send failed; aborting rest\n"
            )
            return 1
        print(f"  chunk {i}/{len(chunks)} sent ({len(chunk)} chars)")

    today = subprocess.check_output(
        ["date", "+%Y-%m-%d"], text=True
    ).strip()
    SENT_FILE.parent.mkdir(parents=True, exist_ok=True)
    SENT_FILE.write_text(today + "\n")
    print(f"OK: morning sent ({len(chunks)} chunks), marked {today}")
    return 0


if __name__ == "__main__":
    TOKEN = get_token()
    sys.exit(main())