#!/usr/bin/env python3
"""command-task-health.json ellenőrzés egy scripted taskhoz.

Használat: python3 smoke-verify-health.py <TASK_NAME> [MAX_AGE_SEC]
   pl. python3 smoke-verify-health.py reggeli-napindito-send 120

Ha FAIL (exit 1): a scripted parancs NEM FUTOTT LE SIKERESEN, rollback szükséges.
Ha OK (exit 0): a scripted parancs sikeresen lefutott, a task kész.
"""
import json
import sys
import time
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 2:
        print("Használat: smoke-verify-health.py <TASK_NAME> [MAX_AGE_SEC]", file=sys.stderr)
        return 2

    task_name = sys.argv[1]
    max_age_sec = int(sys.argv[2]) if len(sys.argv) > 2 else 120

    health_path = Path.home() / "marveen" / "store" / "command-task-health.json"
    if not health_path.exists():
        print(f"HIBA: {health_path} nem található (még sosem futott scripted task?)", file=sys.stderr)
        return 1

    try:
        m = json.loads(health_path.read_text())
    except json.JSONDecodeError as e:
        print(f"HIBA: JSON parse hiba: {e}", file=sys.stderr)
        return 1

    entry = m.get(task_name)
    if not entry:
        print(f"HIBA: {task_name} nincs a command-task-health.json-ban", file=sys.stderr)
        return 1

    last_status = entry.get("lastStatus")
    fails = entry.get("fails", 0)
    last_run = entry.get("lastRun", 0)
    now = int(time.time() * 1000)
    age_ms = now - last_run if last_run else float("inf")
    age_sec = age_ms / 1000 if age_ms != float("inf") else float("inf")

    print(f"task: {task_name}")
    print(f"  lastStatus: {last_status}")
    print(f"  fails: {fails}")
    print(f"  alerted: {entry.get('alerted')}")
    print(f"  lastRun: {age_sec:.1f} másodperce (limit: {max_age_sec}s)")

    errors: list[str] = []
    if last_status != "ok":
        errors.append(f'lastStatus != "ok" (volt: "{last_status}")')
    if fails > 0:
        errors.append(f"fails > 0 (volt: {fails})")
    if age_sec > max_age_sec:
        errors.append(f"lastRun túl régi ({age_sec:.0f}s > {max_age_sec}s) -- a scripted parancs NEM FUTOTT a run-now trigger óta (silent skip gyanú)")

    if errors:
        print("HEALTH FAIL:")
        for e in errors:
            print(f"  - {e}")
        return 1

    print("HEALTH OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())