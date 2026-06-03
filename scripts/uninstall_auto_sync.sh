#!/usr/bin/env bash
set -euo pipefail

label="com.luxiaoxia777.text-extractor.autosync"
plist_path="$HOME/Library/LaunchAgents/$label.plist"
uid="$(id -u)"

launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
rm -f "$plist_path"

echo "Auto sync is stopped and uninstalled."
