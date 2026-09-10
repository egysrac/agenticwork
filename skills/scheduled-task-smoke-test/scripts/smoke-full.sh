#!/usr/bin/env bash
# Teljes end-to-end smoke test egy scheduled task task-config.json módosításához.
#
# Lépések:
#   1. JSON séma-validáció (smoke-validate.py)
#   2. Run-now trigger (curl)
#   3. command-task-health.json ellenőrzés, 30s várakozás után (smoke-verify-health.py)
#   4. task_run history utolsó bejegyzés ellenőrzés
#
# Használat: bash smoke-full.sh <TASK_NAME> [HEALTH_MAX_AGE_SEC]
#   pl. bash smoke-full.sh reggeli-napindito-send 120
#
# Ha bármelyik lépés FAIL: a script megszakad, rollback szükséges (smoke-rollback.sh).

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Használat: $0 <TASK_NAME> [HEALTH_MAX_AGE_SEC]" >&2
  exit 2
fi

TASK="$1"
MAX_AGE="${2:-120}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN=$(cat ~/marveen/store/.dashboard-token 2>/dev/null || echo "")

if [ -z "$TOKEN" ]; then
  echo "HIBA: ~/marveen/store/.dashboard-token nem olvasható" >&2
  exit 1
fi

echo "=== 1/4 JSON séma-validáció ==="
python3 "$SCRIPT_DIR/smoke-validate.py" "$TASK"

echo ""
echo "=== 2/4 Run-now trigger ==="
RESP=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/schedules/$TASK/run-now")
echo "$RESP"
if ! echo "$RESP" | grep -q '"ok":true'; then
  echo "TRIGGER FAIL: a scripted task nem indult el"
  echo "Rollback: bash $SCRIPT_DIR/smoke-rollback.sh $TASK"
  exit 1
fi

echo ""
echo "=== 3/4 command-task-health.json ellenőrzés (30s várakozás) ==="
sleep 30
python3 "$SCRIPT_DIR/smoke-verify-health.py" "$TASK" "$MAX_AGE"

echo ""
echo "=== 4/4 task_run history utolsó bejegyzés ==="
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3420/api/schedules/$TASK/runs" | python3 -m json.tool | tail -15

echo ""
echo "=== SMOKE OK: $TASK scripted task deploy sikeres ==="