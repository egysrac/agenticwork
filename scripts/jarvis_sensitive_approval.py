#!/usr/bin/env python3
"""Jarvis sensitive-művelet approval helper (2026-08-18).

Minden érzékeny (kifelé ható, nehezen visszavonható) Write/Edit/Bash művelet
ELŐTT ezt kell hívni -- a dashboard approvals API-n keresztül Alexnek küld
egy Telegram inline-keyboard üzenetet (a bridge.py `send_approval_request`
már kezeli), és polling-olja a döntést.

A bridge.py MÁR TARTALMAZZA a callback query handler-t:
  - send_approval_request() -> inline keyboard Approve/Decline gombok
  - handle_callback() -> allowlist + APPROVAL_CB_PREFIX decode + PATCH /api/approvals/:id
  - send_message(chat_id, text, reply_markup=None) -> reply_markup paraméterrel

Ez a helper csak a TRIGGER: POST /api/approvals + polling GET /api/approvals/:id.

Használat:
  python3 jarvis_sensitive_approval.py \\
    --category sensitive_file_write \\
    --description "Write ~/.claude/skills/foo/SKILL.md (új skill)" \\
    --payload '{"path":"~/.claude/skills/foo/SKILL.md"}' \\
    --timeout 600

Exit code:
  0  approved
  2  rejected
  3  timeout
  4  error (dashboard unreachable / JSON parse / etc.)

A 4 pontos leírás (mit/melyik/miért/kockázat) a `--description` mezőben menjen,
a meglévő feedback_permission_detailed_description szabály formátumban.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DASHBOARD_BASE = os.environ.get("DASHBOARD_BASE", "http://localhost:3420")
TOKEN_FILE = Path(os.path.expanduser("~/marveen/store/.dashboard-token"))


def _token():
    try:
        return TOKEN_FILE.read_text().strip()
    except Exception as e:
        print(f"jarvis_sensitive_approval: cannot read {TOKEN_FILE}: {e}",
              file=sys.stderr)
        sys.exit(4)


def _request(method, path, body=None):
    url = f"{DASHBOARD_BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {_token()}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode()), None
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode())
        except Exception:
            payload = {"error": str(e)}
        return None, payload
    except Exception as e:
        return None, {"error": str(e)}


def _create_approval(category, description, payload):
    body = {
        "agent_id": "jarvis",
        "category": category,
        "action_description": description,
    }
    if payload is not None:
        body["action_payload"] = payload
    result, err = _request("POST", "/api/approvals", body)
    if err:
        print(f"jarvis_sensitive_approval: POST /api/approvals failed: {err}",
              file=sys.stderr)
        sys.exit(4)
    return result["id"]


def _poll_approval(approval_id, timeout_sec):
    """Poll until the approval is resolved (approved/rejected/timeout) or timeout.
    Returns the final status string."""
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        result, err = _request("GET", f"/api/approvals/{approval_id}")
        if err:
            # Treat transient errors as 'still pending' but back off a bit.
            time.sleep(2)
            continue
        status = result.get("status")
        if status in ("approved", "rejected", "timeout"):
            return status
        time.sleep(2)
    return "timeout"


def main():
    p = argparse.ArgumentParser(description="Jarvis sensitive-művelet approval helper")
    p.add_argument("--category", required=True,
                   help="autonomy-config.json kategória kulcs (pl. sensitive_file_write)")
    p.add_argument("--description", required=True,
                   help="4 pontos leírás (mit/melyik/miért/kockázat)")
    p.add_argument("--payload", default=None,
                   help="opcionális JSON string az action_payload-ba")
    p.add_argument("--timeout", type=int, default=600,
                   help="max várakozás másodpercben (default 600 = 10 perc)")
    args = p.parse_args()

    approval_id = _create_approval(args.category, args.description, args.payload)
    print(f"[jarvis_sensitive_approval] created approval_id={approval_id}",
          file=sys.stderr)

    status = _poll_approval(approval_id, args.timeout)
    print(f"[jarvis_sensitive_approval] final status={status}",
          file=sys.stderr)

    if status == "approved":
        sys.exit(0)
    if status == "rejected":
        sys.exit(2)
    if status == "timeout":
        sys.exit(3)
    sys.exit(4)


if __name__ == "__main__":
    main()
