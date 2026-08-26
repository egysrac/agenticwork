#!/bin/bash
# Egy kerdes feltevese EGY VALASZTOTT modellnek. Ez teszi lehetove, hogy egy
# agens a sajat tervet MAS modellel is felulvizsgaltassa.
#
#   ask-model.sh <modell> "<kerdes>"
#   ask-model.sh <modell> --file <fajl>      # hosszu prompt fajlbol
#
# Modellek:
#   minimax  -> MiniMax-M3        (olcso, ez a flotta alap-motorja)
#   sonnet   -> claude-sonnet-5   (gyors, jo minosegu -- Alex elofizeteset fogyasztja)
#   opus     -> claude-opus-5     (a legerosebb -- csak indokolt esetben)
#   qwen     -> qwen2.5:3b        (helyi, ingyenes, a NUC Ollamajan)
#
# A Claude-agak TISZTA kornyezettel + OAuth-tokennel indulnak, ezert a .env-beli
# MiniMax-atiranyitas nem jut el hozzajuk (ugyanaz a mechanika, mint a hidban).
set -u
M="$HOME/marveen"
MODEL_ARG="${1:-}"
shift || true

if [ -z "$MODEL_ARG" ]; then
  echo "hasznalat: ask-model.sh <minimax|sonnet|opus|qwen> \"<kerdes>\"" >&2
  exit 2
fi

if [ "${1:-}" = "--file" ]; then
  PROMPT="$(cat "${2:?nincs fajl}")"
else
  PROMPT="${*:-}"
fi
[ -n "$PROMPT" ] || { echo "ures kerdes" >&2; exit 2; }

CLAUDE="$HOME/.local/bin/claude"
OAUTH="$M/store/.claude-oauth-token"

claude_clean() {   # $1 = modell-id
  local mdl="$1"
  [ -s "$OAUTH" ] || { echo "(nincs OAuth-token: $OAUTH)" >&2; return 1; }
  cd "$M" || return 1
  env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY \
      -u ANTHROPIC_MODEL -u ANTHROPIC_DEFAULT_SONNET_MODEL \
      -u ANTHROPIC_DEFAULT_OPUS_MODEL -u ANTHROPIC_DEFAULT_HAIKU_MODEL \
      CLAUDE_CODE_OAUTH_TOKEN="$(cat "$OAUTH")" \
      timeout 900 "$CLAUDE" --print --model "$mdl" "$PROMPT"
}

case "$MODEL_ARG" in
  minimax)
    cd "$M" || exit 1
    set -a; . "$M/.env"; set +a
    timeout 1800 "$CLAUDE" --print --model "${MAIN_AGENT_MODEL:-MiniMax-M3}" "$PROMPT"
    ;;
  sonnet) claude_clean claude-sonnet-5 ;;
  opus)   claude_clean claude-opus-5 ;;
  qwen)
    U="$(grep -m1 '^OLLAMA_URL=' "$M/.env" | cut -d= -f2-)"
    python3 - "$U" "$PROMPT" <<'PY'
import json, sys, urllib.request
url, prompt = sys.argv[1], sys.argv[2]
body = json.dumps({"model": "qwen2.5:3b", "prompt": prompt, "stream": False}).encode()
req = urllib.request.Request(f"{url}/api/generate", data=body,
                             headers={"Content-Type": "application/json"})
try:
    with urllib.request.urlopen(req, timeout=600) as r:
        print(json.loads(r.read().decode()).get("response", "").strip())
except Exception as e:
    print(f"(qwen hiba: {e})", file=sys.stderr)
    sys.exit(1)
PY
    ;;
  *)
    echo "ismeretlen modell: $MODEL_ARG (minimax|sonnet|opus|qwen)" >&2
    exit 2
    ;;
esac
