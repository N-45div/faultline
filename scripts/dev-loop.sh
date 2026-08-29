#!/usr/bin/env bash
# Keeps the local anonymous Convex dev server up. On Windows the CLI dies now
# and then (a libuv assertion on exit); this brings it straight back so the
# cron keeps reading the government files while the laptop is awake.
#
#   nohup bash scripts/dev-loop.sh >/dev/null 2>&1 &
#   tail -f .convex-dev.log
cd "$(dirname "$0")/.." || exit 1
export CONVEX_AGENT_MODE=anonymous
while true; do
  echo "[dev-loop] starting $(date '+%F %T')" >> .convex-dev.log
  npx convex dev >> .convex-dev.log 2>&1
  echo "[dev-loop] exited $? at $(date '+%F %T'); restarting in 5s" >> .convex-dev.log
  sleep 5
done
