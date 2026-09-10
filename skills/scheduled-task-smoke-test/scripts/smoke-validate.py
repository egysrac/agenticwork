#!/usr/bin/env python3
"""JSON séma-validáció egy scheduled task task-config.json fájlhoz.

Használat: python3 smoke-validate.py <TASK_NAME>
   pl. python3 smoke-validate.py reggeli-napindito-send

Ha FAIL (exit 1): a task-config.json NINCS konzisztens állapotban, deploy ELŐTT javítandó.
Ha OK (exit 0): a task-config.json sémája helyes, deploy-olható.
"""
import json
import sys
from pathlib import Path

REQUIRED_BY_TYPE = {
    "task": ["prompt"],
    "heartbeat": ["prompt"],
    "command": ["command"],
    "dream-engine": ["prompt"],
}


def main() -> int:
    if len(sys.argv) < 2:
        print("Használat: smoke-validate.py <TASK_NAME>", file=sys.stderr)
        return 2

    task_name = sys.argv[1]
    cfg_path = Path.home() / ".claude" / "scheduled-tasks" / task_name / "task-config.json"
    if not cfg_path.exists():
        print(f"HIBA: {cfg_path} nem található", file=sys.stderr)
        return 1

    try:
        cfg = json.loads(cfg_path.read_text())
    except json.JSONDecodeError as e:
        print(f"HIBA: JSON parse hiba a {cfg_path}-ban: {e}", file=sys.stderr)
        return 1

    errors: list[str] = []
    task_type = cfg.get("type")
    if not task_type:
        errors.append('hiányzó "type" mező')
        return report(errors)

    required = REQUIRED_BY_TYPE.get(task_type, ["prompt"])
    for field in required:
        if not str(cfg.get(field, "")).strip():
            errors.append(f'type="{task_type}" kötelező mező üres/hiányzó: "{field}"')

    if not cfg.get("schedule"):
        errors.append('hiányzó "schedule" mező (cron expression)')

    if cfg.get("type") == "command":
        if cfg.get("timeoutMs") and cfg.get("timeoutMs") <= 0:
            errors.append('"timeoutMs" pozitív kell legyen')
        if cfg.get("failThreshold") and cfg.get("failThreshold") <= 0:
            errors.append('"failThreshold" pozitív kell legyen')

    return report(errors)


def report(errors: list[str]) -> int:
    if errors:
        print("SCHEMA FAIL:")
        for e in errors:
            print(f"  - {e}")
        return 1
    print("SCHEMA OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())