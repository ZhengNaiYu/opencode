#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/naiyu/Desktop/Code/CodingAgent"
HARBOR="$ROOT/harbor"
PACT_HARBOR="$ROOT/opencode/.opencode/plugins/pact/harbor"

command -v colima
command -v docker
command -v uv
command -v bun
command -v opencode
docker compose version
colima status -p swepro
docker context inspect colima-swepro >/dev/null

arch="$(docker run --rm --platform linux/amd64 alpine:3.20 uname -m)"
if [[ "$arch" != "x86_64" ]]; then
  echo "Expected x86_64 from linux/amd64, got: $arch" >&2
  exit 1
fi

env_file="${YUNWU_ENV_FILE:-$HOME/.config/swepro/yunwu.env}"
if [[ -z "${YUNWU_API_KEY:-}" && ! -f "$env_file" ]]; then
  echo "Set YUNWU_API_KEY or create $env_file" >&2
  exit 1
fi

export PYTHONPATH="$PACT_HARBOR${PYTHONPATH:+:$PYTHONPATH}"
export UV_CACHE_DIR="${UV_CACHE_DIR:-/tmp/harbor-uv-cache}"
cd "$HARBOR"
uv run python "$PACT_HARBOR/scripts/validate_configs.py"
echo "Environment and Harbor configs are ready."
