#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
label="com.luxiaoxia777.text-extractor.autosync"
plist_dir="$HOME/Library/LaunchAgents"
plist_path="$plist_dir/$label.plist"
log_dir="$HOME/Library/Logs/text-extractor"
uid="$(id -u)"

mkdir -p "$plist_dir" "$log_dir"

cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$repo_dir/scripts/watch_sync_github.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$repo_dir</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>SYNC_CHECK_INTERVAL</key>
    <string>15</string>
    <key>SYNC_QUIET_SECONDS</key>
    <string>20</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$log_dir/autosync.log</string>
  <key>StandardErrorPath</key>
  <string>$log_dir/autosync.err.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$uid" "$plist_path"
launchctl enable "gui/$uid/$label"
launchctl kickstart -k "gui/$uid/$label"

echo "Auto sync is installed and running."
echo "Logs: $log_dir/autosync.log"
echo "Errors: $log_dir/autosync.err.log"
