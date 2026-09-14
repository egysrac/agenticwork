#!/bin/bash
# Real multi-process contract test for channels.sh startup ownership. All tmux
# state is an isolated filesystem fixture; this never contacts a live server.
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/channels-owner-test.XXXXXX")"
cleanup() {
  _jobs="$(jobs -pr)"
  [ -n "$_jobs" ] && kill $_jobs 2>/dev/null || true
  if [ -f "$TMP/state/tmux-server-pids" ]; then
    while read -r _pid; do kill "$_pid" 2>/dev/null || true; done < "$TMP/state/tmux-server-pids"
  fi
  sleep 0.2
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/install/scripts" "$TMP/install/store" "$TMP/home/.local/bin" "$TMP/state"
cp "$ROOT/scripts/channels.sh" "$TMP/install/scripts/channels.sh"
cp "$ROOT/scripts/telegram-node-runtime.sh" "$TMP/install/scripts/telegram-node-runtime.sh"
printf '#!/bin/bash\nexit 0\n' > "$TMP/install/scripts/set-bot-menu.sh"
chmod +x "$TMP/install/scripts/set-bot-menu.sh"

cat > "$TMP/home/.local/bin/claude" <<'EOF'
#!/bin/bash
exit 0
EOF
cat > "$TMP/home/.local/bin/sleep" <<'EOF'
#!/bin/bash
/bin/sleep 0.03
EOF
cat > "$TMP/home/.local/bin/tmux" <<'EOF'
#!/bin/bash
state="${CHANNELS_TEST_STATE:?}"
cmd="${1:-}"; shift || true
case "$cmd" in
  has-session) [ -f "$state/session" ] ;;
  new-session)
    if ( set -C; : > "$state/session" ) 2>/dev/null; then
      # Model a persistent tmux server descendant. If the supervisor itself
      # owned an inheritable lock fd this process would keep it after a crash.
      /bin/sleep 30 &
      echo $! >> "$state/tmux-server-pids"
      echo "new $$" >> "$state/events"; exit 0
    fi
    echo "duplicate $$" >> "$state/events"; exit 1 ;;
  kill-session) echo "kill $$" >> "$state/events"; rm -f "$state/session" ;;
  capture-pane) echo "Listening for channel messages" ;;
  list-panes) echo $$ ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$TMP/home/.local/bin/claude" "$TMP/home/.local/bin/sleep" "$TMP/home/.local/bin/tmux"

run_channels() {
  HOME="$TMP/home" CHANNEL_PROVIDER=slack CHANNELS_TEST_STATE="$TMP/state" \
    bash "$TMP/install/scripts/channels.sh" "$@" >/dev/null 2>&1 &
  LAST_PID=$!
  PIDS="${PIDS:-} $LAST_PID"
}
run_channels_delayed() {
  HOME="$TMP/home" CHANNEL_PROVIDER=slack CHANNELS_TEST_STATE="$TMP/state" CHANNELS_TEST_DELAY_AFTER_LOCK=0.5 \
    bash "$TMP/install/scripts/channels.sh" "$@" >/dev/null 2>&1 &
  LAST_PID=$!
  PIDS="${PIDS:-} $LAST_PID"
}
run_restart_delayed() {
  HOME="$TMP/home" CHANNEL_PROVIDER=slack CHANNELS_TEST_STATE="$TMP/state" CHANNELS_TEST_DELAY_AFTER_RESTART_ELECTION=0.5 \
    bash "$TMP/install/scripts/channels.sh" restart >/dev/null 2>&1 &
  LAST_PID=$!
  PIDS="${PIDS:-} $LAST_PID"
}
wait_for() {
  file="$1" pattern="$2"
  i=0
  while ! grep -q "$pattern" "$file" 2>/dev/null; do
    i=$((i + 1)); [ "$i" -lt 200 ] || { echo "timeout waiting for $pattern" >&2; exit 1; }
    /bin/sleep 0.03
  done
}
wait_for_count() {
  file="$1" pattern="$2" wanted="$3"
  i=0
  while [ "$(grep -c "$pattern" "$file" 2>/dev/null || true)" -lt "$wanted" ]; do
    i=$((i + 1)); [ "$i" -lt 200 ] || { echo "timeout waiting for $wanted x $pattern" >&2; exit 1; }
    /bin/sleep 0.03
  done
}
wait_for_lock() {
  lock_file="$1"
  i=0
  while flock -n "$lock_file" true 2>/dev/null; do
    i=$((i + 1)); [ "$i" -lt 200 ] || { echo "timeout waiting for held lock" >&2; exit 1; }
    /bin/sleep 0.03
  done
}
wait_for_unlock() {
  lock_file="$1"
  i=0
  while ! flock -n "$lock_file" true 2>/dev/null; do
    i=$((i + 1)); [ "$i" -lt 200 ] || { echo "timeout waiting for released lock" >&2; exit 1; }
    /bin/sleep 0.03
  done
}

# A holder paused after acquisition still owns the kernel lock. The contender
# cannot create during that delay, and the pair produces one session/no kill.
run_channels_delayed --create-if-absent; first=$LAST_PID
/bin/sleep 0.08
run_channels --create-if-absent; second=$LAST_PID
wait "$second" 2>/dev/null || true
! [ -e "$TMP/state/session" ]
wait_for "$TMP/state/events" '^new '
/bin/sleep 0.2
[ "$(grep -c '^new ' "$TMP/state/events")" -eq 1 ]
! grep -q '^kill ' "$TMP/state/events"

# Killing the fd holder releases ownership in the kernel. The persistent lock
# pathname and any unrelated live/reused PID are irrelevant: there is no PID
# metadata to inspect and no stale-lock recovery path.
kill -KILL "$first" 2>/dev/null || true
wait "$first" 2>/dev/null || true
wait_for_unlock "$TMP/install/store/.channels-supervisor.lock"
# The modeled tmux descendant is still alive, proving it did not inherit and
# retain the supervisor's lock across the crash.
_tmux_child="$(head -1 "$TMP/state/tmux-server-pids")"
kill -0 "$_tmux_child"
[ -f "$TMP/install/store/.channels-supervisor.lock" ]
! [ -e "$TMP/install/store/.channels-supervisor.lock/pid" ]
before="$(wc -l < "$TMP/state/events")"
run_channels --create-if-absent; recovered=$LAST_PID
wait "$recovered" 2>/dev/null || true
[ "$(wc -l < "$TMP/state/events")" -eq "$before" ]

# Existing healthy adoption by the service supervisor is non-destructive. A
# concurrent opportunistic creator cannot acquire the lock and also exits
# without killing or duplicating that adopted session.
[ -f "$TMP/state/session" ]
run_channels; adopted=$LAST_PID
wait_for_lock "$TMP/install/store/.channels-supervisor.lock"
run_channels --create-if-absent; opportunistic=$LAST_PID
wait "$opportunistic" 2>/dev/null || true
[ "$(wc -l < "$TMP/state/events")" -eq "$before" ]

# Two concurrent explicit restarts elect one destructive requester. The second
# sees the atomic intent marker and cannot kill the first replacement.
run_restart_delayed; elected=$LAST_PID
wait_for "$TMP/install/store/.channels-restart-requested" '^operator '
run_channels restart; duplicate_restart=$LAST_PID
wait "$duplicate_restart" 2>/dev/null || true
# Simulate Restart=always starting a competing service process while the elected
# operator requester is still alive. It must yield without consuming intent.
run_channels --service-managed; competing_service=$LAST_PID
wait "$competing_service" 2>/dev/null || true
wait_for "$TMP/state/events" '^kill '
wait_for_count "$TMP/state/events" '^new ' 2
/bin/sleep 0.7
[ "$(grep -c '^kill ' "$TMP/state/events")" -eq 1 ]
[ "$(grep -c '^new ' "$TMP/state/events")" -eq 2 ]
! [ -e "$TMP/install/store/.channels-restart-requested" ]

kill "$elected" 2>/dev/null || true
wait "$elected" 2>/dev/null || true
wait_for_unlock "$TMP/install/store/.channels-supervisor.lock"

# A watchdog marker is also consumed once by normal supervision after the old
# owner exits; the surviving dead-plugin session is replaced exactly once.
printf 'watchdog fixture\n' > "$TMP/install/store/.channels-restart-requested"
run_channels; restarted=$LAST_PID
wait_for_count "$TMP/state/events" '^kill ' 2
wait_for_count "$TMP/state/events" '^new ' 3
/bin/sleep 0.2
[ "$(grep -c '^kill ' "$TMP/state/events")" -eq 2 ]
[ "$(grep -c '^new ' "$TMP/state/events")" -eq 3 ]
! [ -e "$TMP/install/store/.channels-restart-requested" ]

# A later dashboard creator cannot kill the healthy replacement.
run_channels --create-if-absent; late=$LAST_PID
wait "$late" 2>/dev/null || true
[ "$(grep -c '^kill ' "$TMP/state/events")" -eq 2 ]
[ "$(grep -c '^new ' "$TMP/state/events")" -eq 3 ]
kill "$restarted" 2>/dev/null || true
wait "$restarted" 2>/dev/null || true
wait_for_unlock "$TMP/install/store/.channels-supervisor.lock"

# A service-manager invocation deliberately replaces a surviving session so
# systemctl/launchctl restart and credential refresh load a new environment.
run_channels --service-managed; managed=$LAST_PID
wait_for_count "$TMP/state/events" '^kill ' 3
wait_for_count "$TMP/state/events" '^new ' 4
[ "$(grep -c '^kill ' "$TMP/state/events")" -eq 3 ]
[ "$(grep -c '^new ' "$TMP/state/events")" -eq 4 ]
kill "$managed" 2>/dev/null || true
wait "$managed" 2>/dev/null || true
wait_for_unlock "$TMP/install/store/.channels-supervisor.lock"

# Crash after restart election but before kill cannot wedge the marker. The
# current owner observes durable intent; service supervision then consumes it.
run_channels; stale_owner=$LAST_PID
wait_for_lock "$TMP/install/store/.channels-supervisor.lock"
run_restart_delayed; stale_winner=$LAST_PID
wait_for "$TMP/install/store/.channels-restart-requested" '^operator '
kill -KILL "$stale_winner" 2>/dev/null || true
wait "$stale_winner" 2>/dev/null || true
run_channels --service-managed; stale_recovery=$LAST_PID
wait_for_count "$TMP/state/events" '^kill ' 4
wait_for_count "$TMP/state/events" '^new ' 5
! [ -e "$TMP/install/store/.channels-restart-requested" ]
kill "$stale_recovery" 2>/dev/null || true
wait "$stale_recovery" 2>/dev/null || true
wait_for_unlock "$TMP/install/store/.channels-supervisor.lock"

# Linux regression: kill -0 succeeds for an unreaped zombie. A zombie restart
# owner must still be classified dead so service recovery cannot remain wedged.
if [ -d /proc/$$ ]; then
  python3 - "$TMP/state/zombie.pid" "$TMP/state/zombie.identity" <<'PYEOF' &
import os, sys, time
pid = os.fork()
if pid == 0:
    os._exit(0)
stat_path = f"/proc/{pid}/stat"
for _ in range(200):
    try:
        fields = open(stat_path).read().split()
        if fields[2] == "Z":
            open(sys.argv[1], "w").write(str(pid))
            open(sys.argv[2], "w").write(fields[21])
            break
    except OSError:
        pass
    time.sleep(0.01)
time.sleep(30)
PYEOF
  zombie_parent=$!
  wait_for "$TMP/state/zombie.pid" '^[0-9]'
  zombie_pid="$(cat "$TMP/state/zombie.pid")"
  zombie_identity="$(cat "$TMP/state/zombie.identity")"
  printf 'operator %s %s %s\n' "$zombie_pid" "$zombie_identity" "$(date +%s)" > "$TMP/install/store/.channels-restart-requested"
  run_channels --service-managed; zombie_recovery=$LAST_PID
  wait_for_count "$TMP/state/events" '^kill ' 5
  wait_for_count "$TMP/state/events" '^new ' 6
  ! [ -e "$TMP/install/store/.channels-restart-requested" ]
  kill "$zombie_recovery" 2>/dev/null || true
  wait "$zombie_recovery" 2>/dev/null || true
  kill "$zombie_parent" 2>/dev/null || true
  wait "$zombie_parent" 2>/dev/null || true
fi

echo "channels startup ownership: ok"
