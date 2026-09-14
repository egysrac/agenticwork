#!/bin/bash
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/telegram-node-runtime-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

make_fixture() {
  home="$1" version="${2:-0.0.7}"
  plugin="$home/.claude/plugins/cache/claude-plugins-official/telegram/$version"
  mkdir -p "$plugin/.claude-plugin" "$home/bin"
  printf '%s\n' '{"name":"claude-channel-telegram","version":"0.0.1","type":"module","bin":"./server.ts","dependencies":{"@modelcontextprotocol/sdk":"^1.0.0","grammy":"^1.21.0"}}' > "$plugin/package.json"
  printf '%s\n' "{\"name\":\"telegram\",\"version\":\"$version\"}" > "$plugin/.claude-plugin/plugin.json"
  printf '%s\n' 'process.stdin.resume()' > "$plugin/server.ts"
  printf '%s\n' '{"mcpServers":{"telegram":{"command":"bun","args":[]}}}' > "$plugin/.mcp.json"
  cat > "$home/bin/npm" <<'EOF'
#!/bin/bash
printf '%s\n' "$*" >> "$NPM_CALLS"
mkdir -p node_modules/@modelcontextprotocol/sdk node_modules/grammy
EOF
  chmod +x "$home/bin/npm"
  printf '%s' "$plugin"
}
prepare() {
  NPM_CALLS="$TMP/npm-calls" HOME="$1" PATH="$1/bin:/usr/bin:/bin" \
    CHANNELS_TEST_AVXLESS=1 CHANNELS_TEST_RUNTIME_DIR="$2" \
    "$ROOT/scripts/telegram-node-runtime.sh" --prepare
}

home="$TMP/happy"; plugin="$(make_fixture "$home")"; runtime="$TMP/runtime-store"
prepare "$home" "$runtime"
grep -Fx -- 'ci --ignore-scripts --omit=dev --no-audit --no-fund --loglevel=error' "$TMP/npm-calls"
python3 - "$plugin/.mcp.json" "$ROOT/scripts/telegram-node-runtime.sh" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))=={"mcpServers":{"telegram":{"command":sys.argv[2],"args":[]}}}
PY
[ -f "$plugin/.mcp.json.marveen-bun-backup" ]
generation="$(find "$runtime" -mindepth 1 -maxdepth 1 -type d ! -name '.prepare-*' | head -1)"
[ -f "$generation/.complete" ] && [ -f "$generation/server.ts" ] && [ -d "$generation/node_modules" ]
# Prepared generation is reused without a second npm resolution.
before="$(wc -l < "$TMP/npm-calls")"; prepare "$home" "$runtime"; [ "$(wc -l < "$TMP/npm-calls")" -eq "$before" ]

# Missing and empty cache fail closed.
empty="$TMP/empty"; mkdir -p "$empty/.claude/plugins/cache/claude-plugins-official/telegram"
if HOME="$empty" CHANNELS_TEST_AVXLESS=1 CHANNELS_TEST_RUNTIME_DIR="$TMP/empty-runtime" "$ROOT/scripts/telegram-node-runtime.sh" --prepare >/dev/null 2>&1; then exit 1; fi
missing="$TMP/missing"; mkdir -p "$missing"
if HOME="$missing" CHANNELS_TEST_AVXLESS=1 CHANNELS_TEST_RUNTIME_DIR="$TMP/missing-runtime" "$ROOT/scripts/telegram-node-runtime.sh" --prepare >/dev/null 2>&1; then exit 1; fi

# Wrong identity and symlinked cache/config are rejected before npm.
home="$TMP/wrong"; plugin="$(make_fixture "$home")"
python3 - "$plugin/package.json" <<'PY'
import json,sys
p=sys.argv[1];d=json.load(open(p));d['name']='wrong';open(p,'w').write(json.dumps(d))
PY
if prepare "$home" "$TMP/wrong-runtime" >/dev/null 2>&1; then exit 1; fi
home="$TMP/link"; plugin="$(make_fixture "$home")"; printf external > "$TMP/external"; rm "$plugin/.mcp.json"; ln -s "$TMP/external" "$plugin/.mcp.json"
if prepare "$home" "$TMP/link-runtime" >/dev/null 2>&1; then exit 1; fi
[ "$(cat "$TMP/external")" = external ]

# AVX-capable is a no-op.
home="$TMP/avx"; plugin="$(make_fixture "$home")"
HOME="$home" CHANNELS_TEST_AVXLESS=0 "$ROOT/scripts/telegram-node-runtime.sh" --prepare
grep -q '"command":"bun"' "$plugin/.mcp.json"

# Runtime executes only the immutable prepared copy, not the mutable cache file.
home="$TMP/run"; plugin="$(make_fixture "$home")"; runtime="$TMP/run-store"; NPM_CALLS="$TMP/run-npm" prepare "$home" "$runtime"
cat > "$home/bin/node" <<'EOF'
#!/bin/bash
if [ "${1:-}" = "-p" ]; then echo 22; exit 0; fi
printf '%s|%s\n' "$PWD" "$*" > "$NODE_CALLS"
EOF
chmod +x "$home/bin/node"
NODE_CALLS="$TMP/node-calls" CLAUDE_PLUGIN_ROOT="$plugin" HOME="$home" PATH="$home/bin:/usr/bin:/bin" \
  CHANNELS_TEST_AVXLESS=1 CHANNELS_TEST_RUNTIME_DIR="$runtime" "$ROOT/scripts/telegram-node-runtime.sh"
case "$(cat "$TMP/node-calls")" in "$runtime"/*'|--experimental-strip-types server.ts') : ;; *) exit 1 ;; esac
# Changing source after prepare changes its digest and therefore cannot select the old runtime.
printf 'malicious replacement\n' > "$plugin/server.ts"
if CLAUDE_PLUGIN_ROOT="$plugin" HOME="$home" PATH="$home/bin:/usr/bin:/bin" CHANNELS_TEST_AVXLESS=1 CHANNELS_TEST_RUNTIME_DIR="$runtime" "$ROOT/scripts/telegram-node-runtime.sh" >/dev/null 2>&1; then exit 1; fi

prepare_line="$(grep -n 'TELEGRAM_NODE_RUNTIME.*--prepare' "$ROOT/scripts/channels.sh" | head -1 | cut -d: -f1)"
lock_line="$(grep -n '^if acquire_channels_owner' "$ROOT/scripts/channels.sh" | head -1 | cut -d: -f1)"
launch_line="$(grep -n '\$TMUX new-session' "$ROOT/scripts/channels.sh" | head -1 | cut -d: -f1)"
[ "$lock_line" -lt "$prepare_line" ] && [ "$prepare_line" -lt "$launch_line" ]
echo "telegram node runtime: ok"
