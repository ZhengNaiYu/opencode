#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/naiyu/Desktop/Code/CodingAgent"
HARBOR="$ROOT/harbor"
PACT_HARBOR="$ROOT/opencode/.opencode/plugins/pact/harbor"
DATASET="$HARBOR/datasets/swepro-evolution"
DEFAULT_TASK="instance_ansible__ansible-1c06c46cc14324df35ac4f39a45fb3ccd602195d-v0f01c69f1e2528b935359cfe578530722bca2c59"

task_input="$DEFAULT_TASK"
arm="both"

usage() {
  cat <<'EOF'
Run one SWE-bench Pro task with Direct OpenCode, OpenCode + PACT, or both.

Usage:
  run_one.sh [--task TASK_ID_OR_PATH] [--arm direct|pact|both]

Options:
  --task TASK_ID_OR_PATH  Dataset directory name or absolute task path.
                         Defaults to the Ansible smoke task.
  --arm ARM              direct, pact, or both. Defaults to both.
  -h, --help             Show this help.

Environment overrides:
  RUN_ID                 Output ID; defaults to YYYYMMDD-HHMMSS.
  RUN_ROOT               Output root; defaults to swebench_pact/runs/$RUN_ID.
  YUNWU_ENV_FILE         Secret env file; defaults to ~/.config/swepro/yunwu.env.
  DIRECT_CONFIG          Direct arm config; defaults to configs/direct-smoke.yaml.

Examples:
  run_one.sh
  run_one.sh --arm pact
  run_one.sh --task instance_navidrome__navidrome-55bff343cdaad1f04496f724eda4b55d422d7f17
  RUN_ID=20260716-one01 run_one.sh --task /absolute/path/to/task --arm both
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task)
      if [[ $# -lt 2 ]]; then
        echo "--task requires a dataset ID or path" >&2
        exit 2
      fi
      task_input="$2"
      shift 2
      ;;
    --arm)
      if [[ $# -lt 2 ]]; then
        echo "--arm requires direct, pact, or both" >&2
        exit 2
      fi
      arm="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$arm" != "direct" && "$arm" != "pact" && "$arm" != "both" ]]; then
  echo "--arm must be direct, pact, or both: $arm" >&2
  exit 2
fi

if [[ "$task_input" = /* ]]; then
  TASK_PATH="$task_input"
else
  TASK_PATH="$DATASET/$task_input"
fi
if [[ ! -f "$TASK_PATH/task.toml" ]]; then
  echo "Task directory does not contain task.toml: $TASK_PATH" >&2
  echo "Available task IDs:" >&2
  find "$DATASET" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort >&2
  exit 2
fi

RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)}"
if [[ ! "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "RUN_ID must contain only letters, numbers, dot, underscore, or hyphen: $RUN_ID" >&2
  exit 2
fi
RUN_ROOT="${RUN_ROOT:-$ROOT/swebench_pact/runs/$RUN_ID}"
ONE_DIR="$RUN_ROOT/one"
if [[ -e "$ONE_DIR" ]]; then
  echo "Refusing to reuse existing one-task directory: $ONE_DIR" >&2
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
DIRECT_CONFIG="${DIRECT_CONFIG:-$PACT_HARBOR/configs/direct-smoke.yaml}"
if [[ ! -f "$DIRECT_CONFIG" ]]; then
  echo "Direct config does not exist: $DIRECT_CONFIG" >&2
  exit 2
fi
cd "$HARBOR"

echo "Run ID: $RUN_ID"
echo "Task: $TASK_PATH"
echo "Arm: $arm"
echo "Output: $ONE_DIR"
if [[ "$arm" == "direct" || "$arm" == "both" ]]; then
  echo "Direct config: $DIRECT_CONFIG"
fi

if [[ "$arm" == "direct" || "$arm" == "both" ]]; then
  uv run harbor trials start \
    -c "$DIRECT_CONFIG" \
    --path "$TASK_PATH" \
    --trial-name one-direct \
    --trials-dir "$ONE_DIR"
fi

if [[ "$arm" == "pact" || "$arm" == "both" ]]; then
  uv run harbor trials start \
    -c "$PACT_HARBOR/configs/pact-smoke.yaml" \
    --path "$TASK_PATH" \
    --trial-name one-pact \
    --trials-dir "$ONE_DIR"
fi

summary_args=("$ONE_DIR")
if [[ "$arm" == "both" ]]; then
  summary_args+=(--expect-pairs 1)
fi
uv run python "$PACT_HARBOR/scripts/summarize.py" "${summary_args[@]}"
