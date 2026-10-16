#!/bin/sh
# Captures the booted store simulators for App Store screenshots.
#   mobile/store/shot.sh 01-priority     → store/screenshots/{iphone,ipad}/01-priority.png
# Only devices that are booted are captured. Status bar is pinned to 9:41, full battery and signal.
set -e
name=${1:?usage: shot.sh <name>}
dir=$(cd "$(dirname "$0")" && pwd)/screenshots
for pair in "iphone:Store iPhone 17 Pro Max" "ipad:Store iPad Pro 13"; do
  kind=${pair%%:*}; label=${pair#*:}
  udid=$(xcrun simctl list devices booted | grep "$label (" | grep -oE '[0-9A-F-]{36}' | head -1)
  [ -n "$udid" ] || continue
  mkdir -p "$dir/$kind"
  xcrun simctl status_bar "$udid" override --time 9:41 --batteryState charged --batteryLevel 100 \
    --cellularBars 4 --wifiBars 3 --dataNetwork wifi >/dev/null 2>&1 || true
  xcrun simctl io "$udid" screenshot --type=png "$dir/$kind/$name.png" >/dev/null 2>&1
  echo "$kind: $dir/$kind/$name.png"
done
