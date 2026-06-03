#!/usr/bin/env bash
set -euo pipefail

check_interval="${SYNC_CHECK_INTERVAL:-15}"
quiet_seconds="${SYNC_QUIET_SECONDS:-20}"

echo "Watching for changes. Press Ctrl+C to stop."
echo "Check interval: ${check_interval}s; quiet period before sync: ${quiet_seconds}s."

while true; do
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Changes detected. Waiting ${quiet_seconds}s before syncing..."
    sleep "$quiet_seconds"

    if [[ -n "$(git status --porcelain)" ]]; then
      bash scripts/sync_github.sh
    else
      echo "Changes were cleared before sync."
    fi
  fi

  sleep "$check_interval"
done
