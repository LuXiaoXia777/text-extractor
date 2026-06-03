#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
label="com.luxiaoxia777.text-extractor.autosync"
plist_dir="$HOME/Library/LaunchAgents"
plist_path="$plist_dir/$label.plist"
log_dir="$HOME/Library/Logs/text-extractor"
support_dir="$HOME/Library/Application Support/text-extractor"
runner_path="$support_dir/autosync_runner.sh"
uid="$(id -u)"

mkdir -p "$plist_dir" "$log_dir" "$support_dir"

cat > "$runner_path" <<RUNNER
#!/usr/bin/env bash
set -euo pipefail

repo_dir="$repo_dir"
check_interval="\${SYNC_CHECK_INTERVAL:-15}"
quiet_seconds="\${SYNC_QUIET_SECONDS:-20}"

cd /tmp

echo "Watching \$repo_dir for changes. Press Ctrl+C to stop."
echo "Check interval: \${check_interval}s; quiet period before sync: \${quiet_seconds}s."

sync_repo() {
  branch="\$(git -C "\$repo_dir" branch --show-current)"

  if [[ -z "\$branch" ]]; then
    echo "Not on a branch. Skipping sync."
    return 1
  fi

  if ! git -C "\$repo_dir" remote get-url origin >/dev/null 2>&1; then
    echo "No origin remote configured. Skipping sync."
    return 1
  fi

  git -C "\$repo_dir" add -A

  if git -C "\$repo_dir" diff --cached --quiet; then
    echo "No local changes to sync."
    git -C "\$repo_dir" status --short --branch
    return 0
  fi

  message="Auto sync \$(date '+%Y-%m-%d %H:%M:%S')"

  git -C "\$repo_dir" commit -m "\$message"
  git -C "\$repo_dir" push -u origin "\$branch"

  echo "Synced \$branch to origin/\$branch."
}

while true; do
  if [[ -n "\$(git -C "\$repo_dir" status --porcelain)" ]]; then
    echo "Changes detected. Waiting \${quiet_seconds}s before syncing..."
    sleep "\$quiet_seconds"

    if [[ -n "\$(git -C "\$repo_dir" status --porcelain)" ]]; then
      sync_repo
    else
      echo "Changes were cleared before sync."
    fi
  fi

  sleep "\$check_interval"
done
RUNNER

chmod +x "$runner_path"

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
    <string>$runner_path</string>
  </array>
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
echo "Runner: $runner_path"
echo "Logs: $log_dir/autosync.log"
echo "Errors: $log_dir/autosync.err.log"
