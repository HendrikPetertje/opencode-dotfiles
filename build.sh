#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# npm only reads the project .npmrc from the folder it runs in, so pass the
# registry to the submodule builds explicitly
export npm_config_registry=https://registry.npmjs.org/

git submodule sync --recursive
git submodule update --init --recursive

git submodule foreach --quiet '
  branch=$(git config -f "$toplevel/.gitmodules" "submodule.$name.branch" || echo main)
  git fetch --quiet origin "$branch" || { echo "$sm_path: no origin/$branch, skipping"; exit 0; }
  if [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$branch")" ]; then
    git checkout --quiet -B "$branch" "origin/$branch"
    git branch --quiet --set-upstream-to="origin/$branch" "$branch"
    echo "$sm_path: on $branch"
  else
    echo "$sm_path: pinned at $(git rev-parse --short HEAD) (differs from origin/$branch), leaving detached"
  fi

  if [ -f package.json ] && jq -e ".scripts.build" package.json >/dev/null; then
    echo "$sm_path: installing and building"
    npm ci --silent --no-fund --no-audit
    npm run --silent build
  fi
'
