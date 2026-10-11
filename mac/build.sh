#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ "$(uname -s)" != Darwin ]]; then
  echo '请在 macOS 14 或以上版本运行本脚本；Linux 无法编译 EventKit 应用。' >&2
  exit 1
fi
app="build/DSH 日历同步.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
xcrun swiftc -swift-version 5 -parse-as-library -O -target "$(uname -m)-apple-macosx14.0" \
  -framework SwiftUI -framework EventKit -framework Security -framework AppKit \
  CalendarSync.swift -o "$app/Contents/MacOS/DSHCalendarSync"
cp Info.plist "$app/Contents/Info.plist"
codesign --force --deep --sign - "$app"
printf '已生成：%s/%s\n' "$PWD" "$app"
