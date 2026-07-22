#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/naiyu/Desktop/Code/CodingAgent"
HARBOR="$ROOT/harbor"
PACT_HARBOR="$ROOT/opencode/.opencode/plugins/pact/harbor"
RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)}"
if [[ ! "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "RUN_ID must contain only letters, numbers, dot, underscore, or hyphen: $RUN_ID" >&2
  exit 2
fi
RUN_ROOT="${RUN_ROOT:-$ROOT/swebench_pact/runs/$RUN_ID}"
DIRECT_DIR="$RUN_ROOT/direct"
PACT_DIR="$RUN_ROOT/pact"

if [[ "${1:-}" != "--execute" ]]; then
  echo "This starts all 8 direct + 8 PACT trials. Re-run with --execute." >&2
  exit 2
fi
if [[ -e "$DIRECT_DIR" || -e "$PACT_DIR" ]]; then
  echo "Refusing to reuse existing full-run directory: $RUN_ROOT" >&2
  exit 2
fi
harbor_env_args=()
env_file="${YUNWU_ENV_FILE:-$HOME/.config/swepro/yunwu.env}"
if [[ -z "${YUNWU_API_KEY:-}" ]]; then
  if [[ ! -f "$env_file" ]]; then
    echo "Set YUNWU_API_KEY or create $env_file" >&2
    exit 1
  fi
  harbor_env_args=(--env-file "$env_file")
fi

export PYTHONPATH="$PACT_HARBOR${PYTHONPATH:+:$PYTHONPATH}"
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/harbor-uv-cache}"
cd "$HARBOR"

echo "Run ID: $RUN_ID"
echo "Direct output: $DIRECT_DIR"
echo "PACT output: $PACT_DIR"

uv run harbor jobs start -c "$PACT_HARBOR/configs/direct.yaml" --jobs-dir "$DIRECT_DIR" -y "${harbor_env_args[@]}"
uv run harbor jobs start -c "$PACT_HARBOR/configs/pact.yaml" --jobs-dir "$PACT_DIR" -y "${harbor_env_args[@]}"

uv run python "$PACT_HARBOR/scripts/summarize.py" \
  "$DIRECT_DIR" \
  "$PACT_DIR" \
  --expect-pairs 8
