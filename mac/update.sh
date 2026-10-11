#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo '请在 Mac 终端运行此脚本。' >&2
  exit 1
fi
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo '请先通过 git clone 下载 DSH-DATE，再执行 mac/update.sh。' >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo '源码有未提交修改。请先提交或自行备份处理，再更新；脚本不会覆盖你的修改。' >&2
  exit 1
fi
git pull --ff-only
bash mac/build.sh
app_source="$PWD/mac/build/DSH 日历同步.app"
install_dir="$HOME/Applications"
app_target="$install_dir/DSH 日历同步.app"
mkdir -p "$install_dir"
if pgrep -x DSHCalendarSync >/dev/null; then
  /usr/bin/osascript -e 'tell application id "org.dsh.calendar-sync" to quit'
  for ((attempt=0; attempt<10; attempt++)); do
    if ! pgrep -x DSHCalendarSync >/dev/null; then break; fi
    sleep 1
  done
  if pgrep -x DSHCalendarSync >/dev/null; then
    echo '旧程序还未退出，请退出后重新执行本脚本。' >&2
    exit 1
  fi
fi
stage_dir="$(mktemp -d "$install_dir/.dsh-calendar-update.XXXXXX")"
# Build and stage before replacing the installed app. Keep its previous copy if installation fails.
trap 'if [[ -d "$stage_dir/previous.app" && ! -e "$app_target" ]]; then mv "$stage_dir/previous.app" "$app_target"; fi; rm -rf "$stage_dir"' EXIT
ditto "$app_source" "$stage_dir/new.app"
if [[ -e "$app_target" ]]; then mv "$app_target" "$stage_dir/previous.app"; fi
mv "$stage_dir/new.app" "$app_target"
open "$app_target"
echo '已更新并打开程序。原有配置、配对令牌和日历记录保留；请点击开启同步。'
