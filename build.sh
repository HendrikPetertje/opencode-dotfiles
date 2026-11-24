#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# npm only reads the project .npmrc from the folder it runs in, so pass the
# release-age guard to the submodule builds explicitly
export npm_config_min_release_age=2

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

  # Peers (@opencode/plugin, @opentui/*, solid-js) must stay the host copies,
  # so they are never installed into a plugin.
  [ -f package.json ] || exit 0
  has_build=$(jq -e ".scripts.build" package.json >/dev/null && echo 1 || true)
  has_deps=$(jq -e "(.dependencies // {}) | length > 0" package.json >/dev/null && echo 1 || true)
  if [ -n "$has_build" ] || [ -n "$has_deps" ]; then
    echo "$sm_path: installing dependencies"
    npm_flags="--silent --no-fund --no-audit --legacy-peer-deps"
    [ -n "$has_build" ] || npm_flags="$npm_flags --omit=dev"
    if [ -f package-lock.json ]; then npm ci $npm_flags; else npm install $npm_flags; fi
  fi
  if [ -n "$has_build" ]; then
    echo "$sm_path: building"
    npm run --silent build
  fi
'
