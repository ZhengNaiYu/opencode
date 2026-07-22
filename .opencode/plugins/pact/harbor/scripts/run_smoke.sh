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
SMOKE_DIR="$RUN_ROOT/smoke"
if [[ -e "$SMOKE_DIR" ]]; then
  echo "Refusing to reuse existing smoke directory: $SMOKE_DIR" >&2
  exit 2
fi

env_file="${YUNWU_ENV_FILE:-$HOME/.config/swepro/yunwu.env}"
if [[ -z "${YUNWU_API_KEY:-}" ]]; then
  if [[ ! -f "$env_file" ]]; then
    echo "Set YUNWU_API_KEY or create $env_file" >&2
    exit 1
  fi
  set -a
  source "$env_file"
  set +a
fi

export PYTHONPATH="$PACT_HARBOR${PYTHONPATH:+:$PYTHONPATH}"
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/harbor-uv-cache}"
cd "$HARBOR"

echo "Run ID: $RUN_ID"
echo "Smoke output: $SMOKE_DIR"

uv run harbor trials start -c "$PACT_HARBOR/configs/oracle-smoke.yaml" --trials-dir "$SMOKE_DIR"
uv run harbor trials start -c "$PACT_HARBOR/configs/direct-smoke.yaml" --trials-dir "$SMOKE_DIR"
uv run harbor trials start -c "$PACT_HARBOR/configs/pact-smoke.yaml" --trials-dir "$SMOKE_DIR"

uv run python "$PACT_HARBOR/scripts/summarize.py" \
  "$SMOKE_DIR"
