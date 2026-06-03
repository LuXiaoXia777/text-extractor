#!/usr/bin/env bash
set -euo pipefail

branch="$(git branch --show-current)"

if [[ -z "$branch" ]]; then
  echo "Not on a branch. Please switch to a branch before syncing."
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "No origin remote configured."
  exit 1
fi

git add -A

if git diff --cached --quiet; then
  echo "No local changes to sync."
  git status --short --branch
  exit 0
fi

message="${1:-Auto sync $(date '+%Y-%m-%d %H:%M:%S')}"

git commit -m "$message"
git push -u origin "$branch"

echo "Synced $branch to origin/$branch."
