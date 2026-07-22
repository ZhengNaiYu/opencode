#!/usr/bin/env bash
set -u

tmp="$(mktemp -d)"
fifo="$tmp/events"
output="$tmp/output.jsonl"
prompt="$tmp/prompt.md"
agent_pid=""
tee_pid=""
agent_group=0

wait_for_exit() {
  local pid="$1"
  local timeout_sec="$2"
  local deadline=$((SECONDS + timeout_sec))
  while kill -0 "$pid" 2>/dev/null; do
    if (( SECONDS >= deadline )); then
      return 1
    fi
    sleep 1
  done
  return 0
}

agent_is_alive() {
  [[ -n "$agent_pid" ]] || return 1
  kill -0 "$agent_pid" 2>/dev/null
}

wait_for_agent_exit() {
  local timeout_sec="$1"
  local deadline=$((SECONDS + timeout_sec))
  while agent_is_alive; do
    if (( SECONDS >= deadline )); then
      return 1
    fi
    sleep 1
  done
  return 0
}

signal_agent() {
  local signal="$1"
  [[ -n "$agent_pid" ]] || return 0
  if [[ "$agent_group" -eq 1 ]]; then
    kill -s "$signal" -- "-$agent_pid" 2>/dev/null || true
  fi
  kill -s "$signal" "$agent_pid" 2>/dev/null || true
}

stop_agent() {
  local initial_grace_sec="$1"
  wait_for_agent_exit "$initial_grace_sec" && return 0

  signal_agent INT
  wait_for_agent_exit "${OPENCODE_OBSERVED_INT_GRACE_SEC:-10}" && return 0

  signal_agent TERM
  wait_for_agent_exit "${OPENCODE_OBSERVED_TERM_GRACE_SEC:-10}" && return 0

  signal_agent KILL
  wait_for_agent_exit "${OPENCODE_OBSERVED_KILL_GRACE_SEC:-5}" || true
}

cleanup() {
  trap - EXIT INT TERM
  if agent_is_alive; then
    signal_agent TERM
    wait_for_agent_exit 2 || true
    signal_agent KILL
  fi
  if [[ -n "$tee_pid" ]] && kill -0 "$tee_pid" 2>/dev/null; then
    kill -TERM "$tee_pid" 2>/dev/null || true
    wait_for_exit "$tee_pid" 2 || kill -KILL "$tee_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cat > "$prompt"
mkfifo "$fifo"
: > "$output"
tee "$output" < "$fifo" &
tee_pid=$!
if [[ -n "${OPENCODE_BIN:-}" ]]; then
  opencode_bin="$OPENCODE_BIN"
elif ! opencode_bin="$(command -v opencode)"; then
  echo "OpenCode executable was not found in PATH." >&2
  exit 127
fi
if [[ ! -x "$opencode_bin" ]]; then
  echo "OpenCode executable is not executable: $opencode_bin" >&2
  exit 126
fi
if command -v setsid >/dev/null 2>&1; then
  setsid "$opencode_bin" "$@" < "$prompt" > "$fifo" 2>&1 &
  agent_group=1
else
  "$opencode_bin" "$@" < "$prompt" > "$fifo" 2>&1 &
fi
agent_pid=$!
terminal=0
timed_out=0
started_at=$SECONDS
timeout_sec="${OPENCODE_OBSERVED_TIMEOUT_SEC:-2700}"

while agent_is_alive; do
  if grep -q '"type":"step_finish".*"reason":"stop"' "$output"; then
    terminal=1
    stop_agent "${OPENCODE_OBSERVED_GRACE_SEC:-15}"
    break
  fi
  if (( timeout_sec > 0 && SECONDS - started_at >= timeout_sec )); then
    timed_out=1
    echo "OpenCode exceeded the ${timeout_sec}s observed-run timeout; terminating it." >&2
    stop_agent 0
    break
  fi
  sleep 1
done

wait "$agent_pid"
status=$?
if ! wait_for_exit "$tee_pid" "${OPENCODE_OBSERVED_TEE_GRACE_SEC:-5}"; then
  kill -TERM "$tee_pid" 2>/dev/null || true
  wait_for_exit "$tee_pid" 2 || kill -KILL "$tee_pid" 2>/dev/null || true
fi
wait "$tee_pid" 2>/dev/null || true
if [[ "$timed_out" -eq 1 ]]; then
  exit 124
fi
if [[ "$terminal" -eq 1 ]]; then
  exit 0
fi
exit "$status"
