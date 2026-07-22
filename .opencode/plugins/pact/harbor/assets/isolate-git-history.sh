#!/usr/bin/env bash
set -euo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY

if [[ $# -ne 1 ]]; then
  echo "usage: isolate-git-history.sh REPOSITORY" >&2
  exit 2
fi

root="$(git -C "$1" rev-parse --show-toplevel)"
marker="$root/.git/benchmark-isolated"

verify_isolation() {
  [[ "$(git -C "$root" rev-list --all --count)" == "1" ]]
  [[ -z "$(git -C "$root" remote)" ]]
  if find "$root" -mindepth 2 -name .git -print -quit | grep -q .; then
    echo "nested Git metadata remains under $root" >&2
    exit 1
  fi
}

if [[ -f "$marker" ]]; then
  verify_isolation
  git -C "$root" rev-parse HEAD
  exit 0
fi

quarantine_parent="${BENCHMARK_QUARANTINE_PARENT:-/root}"
quarantine="$(mktemp -d "$quarantine_parent/benchmark-git.XXXXXX")"
chmod 700 "$quarantine"

index=0
while IFS= read -r -d '' entry; do
  index=$((index + 1))
  mv -- "$entry" "$quarantine/git-$index"
done < <(find "$root" -name .git -prune -print0)

if [[ "$index" -eq 0 ]]; then
  echo "repository has no Git metadata: $root" >&2
  exit 1
fi

git -C "$root" init -q
git -C "$root" config user.name "Benchmark Baseline"
git -C "$root" config user.email "benchmark-baseline@invalid"
git -C "$root" add -A
git -C "$root" commit -q --allow-empty -m "benchmark baseline"
touch "$marker"
rm -rf -- "$quarantine"

verify_isolation
git -C "$root" rev-parse HEAD
