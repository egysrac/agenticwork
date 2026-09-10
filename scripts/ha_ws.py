#!/usr/bin/env python3
"""Home Assistant WebSocket CLI (stdlib + websocket-client).

Auth: long-lived token from store/.homeassistant.json.
Endpoint: wss://<host>/api/websocket (auto from base_url).

Commands:
  raw '<json>'             -- send a raw WS message, print JSON reply
  system-log [--hours N]   -- dump system_log entries (default last 24h)
  get-lovelace [url_path]  -- fetch Lovelace config
  save-lovelace <file>     -- save Lovelace config from JSON file
  list-dashboards          -- list configured dashboards

Patches/revival: 2026-08-09 -- a regi ha_ws.py torolve volt, csak a
CLAUDE.md hivta. Ujra letrehozva Jarvis altal, hogy a HA log review
es a Lovelace edit-ek ujra menjenek.
"""
import sys
import os
import json
import argparse
import ssl
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta

import websocket  # type: ignore

CREDS_FILE = os.path.expanduser("~/marveen/store/.homeassistant.json")


def _creds():
    with open(CREDS_FILE) as f:
        return json.load(f)


def _ws_url(base_url: str) -> str:
    if base_url.startswith("https://"):
        host_part = base_url[len("https://"):]
        return f"wss://{host_part}/api/websocket"
    if base_url.startswith("http://"):
        host_part = base_url[len("http://"):]
        return f"ws://{host_part}/api/websocket"
    raise SystemExit(f"Unsupported base_url scheme: {base_url}")


def _connect(timeout=15):
    creds = _creds()
    base_url = creds["base_url"]
    token = creds["token"]
    ws_url = _ws_url(base_url)

    # websocket-client has its own SSL context handling; we disable verify
    # only as a last-resort fallback (HA uses Let's Encrypt in production).
    sslopt = {"cert_reqs": ssl.CERT_REQUIRED}
    ws = websocket.create_connection(
        ws_url,
        timeout=timeout,
        sslopt=sslopt,
        header=[f"Authorization: Bearer {token}"],
    )
    # HA requires explicit auth message even when header is sent.
    hello = ws.recv()
    hello_json = json.loads(hello)
    if hello_json.get("type") != "auth_required":
        raise SystemExit(f"Unexpected first WS frame: {hello}")
    ws.send(json.dumps({"type": "auth", "access_token": token}))
    auth_ok = json.loads(ws.recv())
    if auth_ok.get("type") != "auth_ok":
        raise SystemExit(f"WS auth failed: {auth_ok}")
    return ws


def _send_and_recv(ws, payload, timeout=15):
    # HA rejects command frames without an "id" (error code invalid_format),
    # so every caller gets one whether it supplied it or not.
    if "id" not in payload:
        payload = dict(payload, id=1)
    ws.settimeout(timeout)
    ws.send(json.dumps(payload))
    chunks = []
    while True:
        try:
            msg = ws.recv()
        except Exception:
            break
        j = json.loads(msg)
        chunks.append(j)
        if not j.get("id") or j.get("type") == "result":
            break
    return chunks


def cmd_raw(args):
    payload = json.loads(args.payload)
    if "id" not in payload:
        payload["id"] = 1
    ws = _connect()
    try:
        result = _send_and_recv(ws, payload)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        ws.close()


def cmd_system_log(args):
    ws = _connect()
    try:
        result = _send_and_recv(ws, {"type": "system_log/list"})
        # Result is the last entry with type==result.
        entries = []
        for r in result:
            if r.get("type") == "result" and r.get("success"):
                entries = r.get("result", []) or []
                break
        # Optional filter
        if args.hours is not None:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=args.hours)
            filtered = []
            for e in entries:
                ts = e.get("timestamp") or e.get("created")
                if ts is None:
                    filtered.append(e)
                    continue
                try:
                    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                except Exception:
                    filtered.append(e)
                    continue
                if dt >= cutoff:
                    filtered.append(e)
            entries = filtered
        # Level filter
        if args.level:
            lv = args.level.upper()
            entries = [e for e in entries if (e.get("level") or "").upper() == lv]
        if args.limit:
            entries = entries[: args.limit]
        print(json.dumps(entries, ensure_ascii=False, indent=2))
    finally:
        ws.close()


def cmd_get_lovelace(args):
    url_path = args.url_path or "lovelace"
    ws = _connect()
    try:
        result = _send_and_recv(
            ws, {"type": "lovelace/config", "url_path": url_path}
        )
        for r in result:
            if r.get("type") == "result":
                print(json.dumps(r, ensure_ascii=False, indent=2))
                return
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        ws.close()


def cmd_save_lovelace(args):
    with open(args.file) as f:
        config = json.load(f)
    ws = _connect()
    try:
        result = _send_and_recv(
            ws,
            {
                "type": "lovelace/config/save",
                "url_path": args.url_path or "lovelace",
                "config": config,
            },
        )
        for r in result:
            if r.get("type") == "result":
                print(json.dumps(r, ensure_ascii=False, indent=2))
                return
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        ws.close()


def cmd_list_dashboards(args):
    ws = _connect()
    try:
        result = _send_and_recv(ws, {"type": "lovelace/dashboards/list"})
        for r in result:
            if r.get("type") == "result":
                print(json.dumps(r, ensure_ascii=False, indent=2))
                return
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        ws.close()


def main():
    p = argparse.ArgumentParser(description="Home Assistant WebSocket CLI")
    sub = p.add_subparsers(dest="cmd", required=True)

    p_raw = sub.add_parser("raw", help="send a raw WS message")
    p_raw.add_argument("payload")
    p_raw.set_defaults(func=cmd_raw)

    p_sl = sub.add_parser("system-log", help="dump system_log entries")
    p_sl.add_argument("--hours", type=int, default=None)
    p_sl.add_argument("--level", choices=["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"], default=None)
    p_sl.add_argument("--limit", type=int, default=None)
    p_sl.set_defaults(func=cmd_system_log)

    p_gl = sub.add_parser("get-lovelace", help="fetch Lovelace config")
    p_gl.add_argument("url_path", nargs="?", default=None)
    p_gl.set_defaults(func=cmd_get_lovelace)

    p_slv = sub.add_parser("save-lovelace", help="save Lovelace config from file")
    p_slv.add_argument("file")
    p_slv.add_argument("url_path", nargs="?", default=None)
    p_slv.set_defaults(func=cmd_save_lovelace)

    p_ld = sub.add_parser("list-dashboards", help="list configured dashboards")
    p_ld.set_defaults(func=cmd_list_dashboards)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
