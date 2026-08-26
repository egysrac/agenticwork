#!/bin/bash
# HA host (.53) hardware probe via REST API.
# Use this when HA is up and you have a long-lived token.
# Replaces an SSH-based probe with a non-invasive API call.
#
# Usage: HA_TOKEN=eyJ... ./ha-host-probe.sh
# Output: hostname, OS, arch, docker availability, supervisor type

set -euo pipefail
TOKEN="${HA_TOKEN:-}"
HA_URL="${HA_URL:-http://192.168.1.53:8123}"

if [ -z "$TOKEN" ]; then
  echo "ERROR: HA_TOKEN env var required (HA long-lived token)" >&2
  exit 1
fi

echo "=== Probe $HA_URL ==="
echo "Test /api/..."
if ! curl -s -f --max-time 5 -H "Authorization: Bearer $TOKEN" "$HA_URL/api/" > /dev/null; then
  echo "FAIL: HA API not responding" >&2
  exit 2
fi

echo "OK -- fetching host info"
echo
echo "--- /api/host_info ---"
curl -s -H "Authorization: Bearer $TOKEN" "$HA_URL/api/host_info" | python3 -m json.tool 2>/dev/null || true
echo
echo "--- /api/hassio/host/info (supervisor) ---"
curl -s -H "Authorization: Bearer $TOKEN" "$HA_URL/api/hassio/host/info" | python3 -m json.tool 2>/dev/null || true
echo
echo "--- /api/hassio/supervisor/info ---"
curl -s -H "Authorization: Bearer $TOKEN" "$HA_URL/api/hassio/supervisor/info" | python3 -m json.tool 2>/dev/null || true
echo
echo "--- Memory/system_monitor sensors (HA-ból, ha fent van) ---"
curl -s -H "Authorization: Bearer $TOKEN" "$HA_URL/api/states" | \
  python3 -c "
import json, sys
states = json.load(sys.stdin)
keywords = ['memory', 'cpu', 'disk', 'processor', 'swap']
for s in states:
    eid = s.get('entity_id','')
    if any(k in eid.lower() for k in keywords):
        attrs = s.get('attributes', {})
        unit = attrs.get('unit_of_measurement','')
        print(f\"  {eid}: {s.get('state','')} {unit}\")
" 2>/dev/null || true
