#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

git submodule sync --recursive
git submodule update --init --recursive

git submodule foreach --quiet '
  git fetch --quiet origin main || { echo "$sm_path: no origin/main, skipping"; exit 0; }
  if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]; then
    git checkout --quiet -B main origin/main
    git branch --quiet --set-upstream-to=origin/main main
    echo "$sm_path: on main"
  else
    echo "$sm_path: pinned at $(git rev-parse --short HEAD) (differs from origin/main), leaving detached"
  fi
'
