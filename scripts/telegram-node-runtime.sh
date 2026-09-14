#!/bin/bash
# Locked, immutable Node runtime for the official Telegram Channels plugin on
# AVX-less Linux x86 hosts. No token is read or printed here.
set -eu

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
INSTALL_DIR="$(cd "$(dirname "$SELF")/.." && pwd)"
LOCKFILE="$INSTALL_DIR/scripts/telegram-node-runtime.package-lock.json"

is_avxless_x86() {
  [ "${CHANNELS_TEST_AVXLESS:-}" = "1" ] && return 0
  [ "${CHANNELS_TEST_AVXLESS:-}" = "0" ] && return 1
  grep -qE '^flags[[:space:]]*:' /proc/cpuinfo 2>/dev/null \
    && ! grep -qiw avx /proc/cpuinfo 2>/dev/null
}

runtime_base() {
  if [ "${CHANNELS_TEST_AVXLESS:-}" = "1" ] && [ -n "${CHANNELS_TEST_RUNTIME_DIR:-}" ]; then
    printf '%s\n' "$CHANNELS_TEST_RUNTIME_DIR"
  else
    printf '%s\n' "$INSTALL_DIR/store/telegram-node-runtime"
  fi
}

plugin_facts() {
  python3 - "$1" "$HOME/.claude/plugins/cache/claude-plugins-official/telegram" "$HOME" <<'PY'
import hashlib, json, os, re, stat, sys
root, base, home = map(os.path.abspath, sys.argv[1:])
if os.path.dirname(root) != base or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?", os.path.basename(root)):
    raise SystemExit(1)
relative = os.path.relpath(root, home)
if relative == ".." or relative.startswith(".." + os.sep):
    raise SystemExit(1)
component = home
for part in relative.split(os.sep):
    component = os.path.join(component, part)
    if stat.S_ISLNK(os.lstat(component).st_mode):
        raise SystemExit(1)
required = ["package.json", "server.ts", ".mcp.json", ".claude-plugin/plugin.json"]
for rel in required:
    p = os.path.join(root, rel)
    st = os.lstat(p)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
        raise SystemExit(1)
with open(os.path.join(root, "package.json"), encoding="utf-8") as f:
    package = json.load(f)
with open(os.path.join(root, ".claude-plugin", "plugin.json"), encoding="utf-8") as f:
    manifest = json.load(f)
if package.get("name") != "claude-channel-telegram" or package.get("type") != "module":
    raise SystemExit(1)
if manifest.get("name") != "telegram" or manifest.get("version") != os.path.basename(root):
    raise SystemExit(1)
server = open(os.path.join(root, "server.ts"), "rb").read()
print(os.path.basename(root), hashlib.sha256(server).hexdigest())
PY
}

runtime_valid() {
  python3 - "$1" "$2" <<'PY'
import hashlib, os, stat, sys
root, expected = sys.argv[1:]
st = os.lstat(root)
if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode): raise SystemExit(1)
for rel in ("server.ts", "package.json", "package-lock.json", ".complete"):
    p=os.path.join(root, rel); st=os.lstat(p)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode): raise SystemExit(1)
if open(os.path.join(root, ".complete"), encoding="ascii").read().strip() != expected: raise SystemExit(1)
if hashlib.sha256(open(os.path.join(root, "server.ts"), "rb").read()).hexdigest() != expected: raise SystemExit(1)
PY
}

write_mcp_config() {
  plugin="$1"
  python3 - "$plugin/.mcp.json" "$SELF" <<'PY'
import json, os, stat, sys, tempfile
path, wrapper = sys.argv[1:]
if stat.S_ISLNK(os.lstat(path).st_mode): raise SystemExit(1)
generated={"mcpServers":{"telegram":{"command":wrapper,"args":[]}}}
with open(path, encoding="utf-8") as f: current=json.load(f)
backup=path+".marveen-bun-backup"
if current != generated and not os.path.lexists(backup):
    fd,tmp=tempfile.mkstemp(dir=os.path.dirname(path),prefix=".mcp-backup-",suffix=".tmp")
    try:
        with os.fdopen(fd,"w",encoding="utf-8") as f: json.dump(current,f,separators=(",",":")); f.write("\n"); f.flush(); os.fsync(f.fileno())
        os.replace(tmp,backup)
    finally:
        try: os.unlink(tmp)
        except FileNotFoundError: pass
fd,tmp=tempfile.mkstemp(dir=os.path.dirname(path),prefix=".mcp-node-",suffix=".tmp")
try:
    with os.fdopen(fd,"w",encoding="utf-8") as f: json.dump(generated,f,indent=2); f.write("\n"); f.flush(); os.fsync(f.fileno())
    os.replace(tmp,path)
finally:
    try: os.unlink(tmp)
    except FileNotFoundError: pass
PY
}

prepare_plugin() {
  plugin="$1"
  facts="$(plugin_facts "$plugin")" || { echo "telegram-node-runtime: rejected invalid official cache entry" >&2; return 1; }
  version="${facts%% *}"; digest="${facts##* }"
  base="$(runtime_base)"; mkdir -p -m 700 "$base"
  generation="$base/${version}-${digest}"
  if ! runtime_valid "$generation" "$digest" 2>/dev/null; then
    tmp="$(mktemp -d "$base/.prepare-${version}.XXXXXX")"
    if ! python3 - "$plugin" "$tmp" "$digest" <<'PY'
import hashlib, json, os, stat, sys
src,dst,expected=sys.argv[1:]
for name in ("server.ts","package.json"):
    p=os.path.join(src,name); fd=os.open(p,os.O_RDONLY|getattr(os,"O_NOFOLLOW",0))
    try: data=os.read(fd,os.fstat(fd).st_size+1)
    finally: os.close(fd)
    open(os.path.join(dst,name),"wb").write(data)
if hashlib.sha256(open(os.path.join(dst,"server.ts"),"rb").read()).hexdigest()!=expected: raise SystemExit(1)
p=json.load(open(os.path.join(dst,"package.json")))
if p.get("name")!="claude-channel-telegram" or p.get("type")!="module": raise SystemExit(1)
PY
    then rm -rf "$tmp"; return 1; fi
    cp "$LOCKFILE" "$tmp/package-lock.json"
    if ! (cd "$tmp" && timeout 120 env -u TELEGRAM_BOT_TOKEN npm ci --ignore-scripts --omit=dev --no-audit --no-fund --loglevel=error >/dev/null 2>&1); then
      rm -rf "$tmp"; echo "telegram-node-runtime: locked dependency preparation failed" >&2; return 1
    fi
    printf '%s\n' "$digest" > "$tmp/.complete"
    current="$(plugin_facts "$plugin")" || { rm -rf "$tmp"; return 1; }
    [ "$current" = "$facts" ] || { rm -rf "$tmp"; echo "telegram-node-runtime: plugin changed during preparation" >&2; return 1; }
    if ! mv "$tmp" "$generation" 2>/dev/null; then rm -rf "$tmp"; fi
    runtime_valid "$generation" "$digest" || return 1
  fi
  [ "$(plugin_facts "$plugin")" = "$facts" ] || return 1
  write_mcp_config "$plugin"
}

case "${1:-}" in
  --prepare)
    [ "$#" -eq 1 ] || exit 2
    is_avxless_x86 || exit 0
    [ -f "$LOCKFILE" ] || { echo "telegram-node-runtime: shipped lockfile missing" >&2; exit 1; }
    base="$HOME/.claude/plugins/cache/claude-plugins-official/telegram"
    [ -d "$base" ] || { echo "telegram-node-runtime: official Telegram cache missing" >&2; exit 1; }
    found=false
    for plugin in "$base"/*; do [ -d "$plugin" ] || continue; found=true; prepare_plugin "$plugin" || exit 1; done
    [ "$found" = true ] || { echo "telegram-node-runtime: official Telegram cache empty" >&2; exit 1; }
    ;;
  "")
    is_avxless_x86 || { echo "telegram-node-runtime: fallback refused on AVX-capable host" >&2; exit 1; }
    plugin="${CLAUDE_PLUGIN_ROOT:-}"; [ -n "$plugin" ] || { echo "telegram-node-runtime: CLAUDE_PLUGIN_ROOT is required" >&2; exit 1; }
    facts="$(plugin_facts "$plugin")" || { echo "telegram-node-runtime: rejected plugin root" >&2; exit 1; }
    version="${facts%% *}"; digest="${facts##* }"; generation="$(runtime_base)/${version}-${digest}"
    runtime_valid "$generation" "$digest" || { echo "telegram-node-runtime: prepared immutable runtime missing or invalid" >&2; exit 1; }
    node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
    case "$node_major" in 22|23) ;; *) echo "telegram-node-runtime: Node 22 or 23 required" >&2; exit 1 ;; esac
    cd "$generation"
    exec node --experimental-strip-types server.ts
    ;;
  *) echo "Usage: $0 [--prepare]" >&2; exit 2 ;;
esac
