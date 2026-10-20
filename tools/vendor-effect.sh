#!/usr/bin/env bash
set -euo pipefail

root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
version=$(grep -oE '"effect": \["effect@[^"]+"' "$root/bun.lock" | sed -E 's/.*effect@//; s/"$//')
if [[ -z $version ]]; then
  echo "vendor-effect: no effect entry in $root/bun.lock" >&2
  exit 1
fi
tag="effect@$version"
dir="$root/.repos/effect"

mkdir -p "$root/.repos"
exec 9>"$root/.repos/.lock"
flock -n 9 || exit 0

if [[ -d $dir/.git ]]; then
  if [[ $(git -C "$dir" rev-parse -q --verify "refs/tags/$tag^{commit}" || true) != $(git -C "$dir" rev-parse HEAD) ]]; then
    git -C "$dir" fetch -q --depth 1 origin tag "$tag"
    git -C "$dir" -c advice.detachedHead=false checkout -q --detach "$tag"
  fi
else
  git -c advice.detachedHead=false clone -q --depth 1 --branch "$tag" https://github.com/Effect-TS/effect.git "$dir"
fi
find "$dir" -path "$dir/.git" -prune -o -type f \( -name AGENTS.md -o -iname llms.md \) -exec rm -f {} +
