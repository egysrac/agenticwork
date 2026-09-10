#!/usr/bin/env bash
# Rollback a legutóbbi backup-ra egy scheduled task task-config.json fájlhoz.
#
# Használat: bash smoke-rollback.sh <TASK_NAME>
#   pl. bash smoke-rollback.sh reggeli-napindito-send
#
# Ha nincs backup: exit 1, semmi nem változik.
# Ha van backup: a legfrissebb .bak-* fájlt visszaállítja, és kilistázza.

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Használat: $0 <TASK_NAME>" >&2
  exit 2
fi

TASK="$1"
CFG_DIR="$HOME/.claude/scheduled-tasks/$TASK"

if [ ! -d "$CFG_DIR" ]; then
  echo "HIBA: $CFG_DIR nem létezik" >&2
  exit 1
fi

LATEST_BAK=$(ls -t "$CFG_DIR"/task-config.json.bak-* 2>/dev/null | head -1 || true)

if [ -z "${LATEST_BAK:-}" ]; then
  echo "HIBA: nincs backup a $CFG_DIR mappában (.bak-* fájl)" >&2
  exit 1
fi

echo "Rollback: $LATEST_BAK -> $CFG_DIR/task-config.json"
cp "$LATEST_BAK" "$CFG_DIR/task-config.json"
echo "Kész. A schedule-runner 60s-en belül újraolvassa (vagy service restart kell)."
ls -la "$CFG_DIR/task-config.json"*