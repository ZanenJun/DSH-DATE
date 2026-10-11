# DSH-DATE · 日历与待办助手

独立的 DeepSeek Harness 插件：在 QQ 私聊中管理日历、待办和习惯；Linux 保存 JSON，由 hook 唤起 Agent 催促。支持 **Linux 直连 iCloud 日历**，Mac 无需开机；保留旧 Mac 本地同步方式作为可选后端。

**兼容版本：** Linux、Node.js ≥ 22.13、DSH `0.2.0-rc.2`、OneBot v11（已对接 SnowLuma）。iCloud 使用 Apple 账户与 App 专用密码，经 HTTPS CalDAV 访问 Apple 服务器；无需安装 Mac 配套程序或保持 SSH 隧道。协议与故障场景已通过模拟服务测试，真实账户登录及双向同步需在填写凭据后验收。

## 行为

- 用 QQ 说“明天 9 点提醒我开会”“每天 22 点提醒我整理房间”“每周一、三 19 点运动”。时间不明确时助手会询问。
- 到点通过 `calendar-agent/reminder-due` hook 唤起真正的 DSH Agent，根据事项、逾期时长、成功催促次数、上次正文及近期回复生成中文提醒，再给管理员 QQ 发私聊。每次最多合并 20 项，轮转避免遗漏。
- 无回复时，上次发送后至少 30 秒开始下一次生成；模型耗时会增加实际间隔。语气逐渐直接但不责备。生成期间发生回复、改期、完成、删除或延后，会取消旧稿。
- 管理员的**任何私聊回复**通过 `calendar-agent/message` hook 暂停所有已提醒事项的当次催促；不会自动标记完成。
- 明确说“完成 + 事项”才标记完成。只有一个待确认事项时“完成”也可；有多个时助手应询问。习惯只完成当次，下一次照常提醒。
- “稍后 10 分钟”恢复为延后提醒。修改计划时间会取消旧提醒。
- JSON 保存事项、重复规则、每次提醒状态、版本和删除记录。另保留最近 200 条变更、用户回复和成功催促记录。QQ Agent 每轮自动注入当前事项和最近记忆，换会话或服务重启后也可读取；完整事项仍通过 calendar_list 查询。
- QQ 或回复监听断开时暂停发送。催促依赖 DSH 默认模型/API；模型失败会记录错误并按间隔重试，不回退到固定文案。停机跨过多个习惯周期只补最近一次。
- 使用专用「DSH 日历助手」日历。普通待办/事件的标题、备注、起止时间和时区双向同步；iCloud 新建事件作为待办导入。云端删除经两次完整同步及单独读取确认后生效。完成显示 `✓`，完成操作请通过 QQ。
- 习惯及重复事项只向日历展示上个月、本月和下个月的事件（`↻`）；其修改、删除会在后续同步恢复。**请在 QQ 修改习惯规则**。全天事件、原生重复事件和会议邀请不支持导入。
- 两端同时修改同一事项时保留冲突，不自动覆盖。iCloud 模式用 `icloud-resolve` 选择保留版本；旧 Mac 模式仍在配套应用中处理冲突。

## iCloud 直连（推荐）

安装插件后，在 **Linux 服务器终端**执行：

```bash
export DSH_HOME=/path/to/your/dsh-home
node bin/calendar.js icloud-setup
node bin/calendar.js icloud-status
```

命令会依次询问 Apple 账户邮箱、App 专用密码（不回显）和专用日历。先在 [Apple 账户页面](https://account.apple.com) 的“登录与安全 → App 专用密码”生成密码，需要开启双重认证。不要填写 Apple 主密码，也不要把密码提交 Git 或发给 Agent。成功配置后自动通知运行中的插件加载；若 DSH 未运行，启动或重启后生效。

选择 iCloud 下的「DSH 日历助手」。Linux ↔ iCloud 双向同步普通事件，iPhone / Mac 使用系统 iCloud 同步。习惯仍由 QQ 管理，云端只同步上个月、本月和下个月的普通事件及习惯投影，窗口随月份滚动。每轮同步结束后等待 20 秒再开始，失败会退避重试；云端及设备网络可能增加延迟。原生重复、全天事件及会议邀请保留在云端，但不导入为待办。

每次调用日历 MCP 工具会主动请求同步：查询前拉取，保存、删除及提醒操作后同步。工具最多等待 8 秒，慢请求继续在后台运行；返回实际同步状态，网络失败不会撤销已保存的事项。已有旧配置请把 `icloud.intervalMs` 改为 `20000` 并重启 DSH；未指定时默认 20 秒。QQ 催促间隔仍为 30 秒。

启用后旧 Mac 同步程序会被拒绝访问，请退出它。无需删除日历、JSON 或 Mac 映射。符合旧 `dshcalendar://item/ID` 标记且两端内容一致的事件会接管原 ID；内容不一致则保留冲突，避免重复导入或静默覆盖。完整配置、冲突处理与迁移说明见 [iCloud 设置](docs/ICLOUD_SETUP.md)。

## 旧 Mac 后端：通过 Git 安装和更新（可选）

第一次在 Mac 终端执行（需要 macOS 14+ 和 Xcode Command Line Tools）：

```bash
git clone https://github.com/ZanenJun/DSH-DATE.git ~/DSH-DATE
bash ~/DSH-DATE/mac/update.sh
```

以后更新只需：

```bash
bash ~/DSH-DATE/mac/update.sh
```

脚本拉取最新代码、编译、退出旧程序，将新版安装到 `~/Applications/DSH 日历同步.app` 并打开。配置、钥匙串令牌和日历映射保留；程序打开后点击开启同步。SSH 隧道仍需保持连接。如果源码有未提交修改或分支分叉，脚本会停止，避免覆盖本地修改。已用压缩包安装的用户也可按首次安装命令迁移，无需删除旧同步记录。

## 安装到 DSH

先准备已能聊天的 DSH + qq-bridge + SnowLuma/OneBot。插件不包含 QQ 客户端、DSH 本体或任何凭据。

```bash
git clone https://github.com/ZanenJun/DSH-DATE.git
cd DSH-DATE
npm ci --omit=dev
export DSH_HOME=/path/to/your/dsh-home
node bin/calendar.js init \
  --owner YOUR_ADMIN_QQ --bot YOUR_BOT_QQ \
  --onebot /path/to/onebot_BOT_QQ.json
node bin/calendar.js install
```

`init` 不覆盖已有配置。`install` 在 DSH 的 `web` profile 追加 bundle 并备份原 manifest；其他 profile 用 `--profile NAME`。保留本目录，profile 使用本地链接加载插件。重启 DSH，选择 **calendar-assistant（日历与待办助手）**。

qq-bridge 配置：`agentPreset: "calendar-assistant"`；在控制台选择 `chat` 模式，私聊白名单只加入管理员 QQ，群白名单留空且 `allowAllWhenEmpty: false`。关闭 `socialV2.enabled` 与 `slang.enabled`，避免社交角色/黑话任务干扰。机器人与管理员必须是两个不同账号。

配置默认位于 `$DSH_HOME/calendar-agent/config.json`（DSH_HOME 未指定时 `~/.dsh`）。支持 `DSH_CALENDAR_CONFIG` 指定其他路径；需要同时传入 **DSH 服务环境**，不能只在安装终端设置。可编辑时区、端口及 OneBot 的 HTTP/WS 地址；仅允许回环地址，远程服务用 SSH 转发。其他 OneBot 实现可以用独立 `httpTokenFile` / `wsTokenFile`。

```bash
node bin/calendar.js status
node bin/calendar.js pair           # 显示地址和令牌文件路径，不显示令牌
node bin/calendar.js pair --show-token # 仅在你自己的终端中查看配对令牌
```

插件随 DSH 生命周期启动和停止；请让 DSH 和 QQ 客户端由系统服务自动启动。不要同时启动第二个 `serve` 进程占用相同数据目录。

## Linux stdio MCP

DSH preset 已自动通过 stdio 连接本插件 MCP。其他 MCP 客户端也可以连接：

```json
{
  "mcpServers": {
    "calendar": {
      "command": "node",
      "args": ["/absolute/path/dsh-calendar-agent/src/mcp.js", "/absolute/path/calendar-agent/config.json"]
    }
  }
}
```

MCP 只在标准输出传协议消息；工具为 `calendar_list`、`calendar_save`、`calendar_delete`、`calendar_reminder`。独立运行 `node bin/calendar.js serve` 仅提供数据服务和同步接口；Agent 催促需要在 DSH 中加载本插件。DSH 内的名字加前缀 `mcp__calendar__`。

可在本地配置文件增加 `reminder: { "tone": "亲切简短，未回复时更直接", "timeoutMs": 45000 }`，重启 DSH 后生效。提醒 Agent 使用 DSH 默认模型，没有写入或发送工具；生成成功后由 hook 核验最新状态再投递。对话 Agent 保留四个日历 MCP 工具。

## 旧 Mac 后端接入（仅未启用 iCloud 直连时）

详见 [Mac 安装说明](docs/MAC_SETUP.md)。通过上面的 Git 命令安装应用，填回环地址与配对令牌，授予**完整日历访问权限**，点击开启同步。同步需要应用保持运行；Mac 休眠或离线期间暂停，恢复后继续。服务器提醒独立运行，不受 Mac 是否在线影响。

API 只监听 Linux 的 `127.0.0.1:3217`。建议从 Mac 建立 SSH 隧道，不要将端口直接暴露公网：

```bash
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -L 127.0.0.1:3217:127.0.0.1:3217 YOUR_USER@YOUR_SERVER
```

令牌存于 Linux 数据目录的 `access-token`（600），Mac 存钥匙串。分享安装包不包含令牌、QQ 号、API key 或个人日历数据。

## 数据和同步协议

见 [协议及 hook](docs/PROTOCOL.md)。`data/calendar/YYYY-MM.json` 按配置时区的开始月份保存事项和提醒状态；聊天与催促正文在 `data/history.json`，同步映射、幂等记录等运行元数据在 `data/state.json`。`data/calendar.json` 现在只是月份索引。`data/backup/` 保留上一次提交的分文件快照，迁移前的原文件保存在 `data/legacy/`。单进程拥有写锁，所有写入排队；持久事务日志确保跨月移动可在重启后恢复。详见 [分月存储与迁移](docs/STORAGE.md)。不要在服务运行时直接改 JSON。手动修复前停止 DSH、备份整个数据目录，再编辑或恢复。

项目为个人单用户、小规模日历设计；历史和幂等记录当前不自动清理。默认时区 Asia/Shanghai；按日历墙钟计算每日/每周重复，支持夏令时。精确执行时间受服务器调度、网络和 QQ 平台影响。消息已被 QQ 接收但写盘前崩溃时，恢复后可能重复一次，不承诺恰好一次发送。

iCloud 在 CalDAV 请求中限定上个月、本月和下个月。窗口外本地数据继续按月归档，云端旧事件不因滚动窗口被删除；已同步事项跨出边界时会完成一次必要的移出确认，随后暂停跟踪。旧 Mac 可选后端仍采用其原有扫描范围，不是当前推荐的 iCloud 直连方式。专用日历丢失或权限撤回时停止同步，不把整本日历丢失当成“删除所有事项”。换账户/迁移日历前请备份同步记录。

## 开发与测试

```bash
npm ci
npm run check
npm test
npm pack
```

测试覆盖真实 stdio MCP、API 鉴权、CAS/幂等/删除、催促间隔、生成中回复/改期/完成/删除/延后的旧稿取消、模型失败、持久记忆、身份与重放、习惯周期、夏令时和重启；以及 CalDAV 发现、重定向、条件写入、断网恢复、双端冲突和迁移接管。自动测试使用临时目录、模拟 QQ 和模拟 Apple 协议响应。GitHub Actions 编译 Mac；真实 iCloud 账户和 EventKit 行为仍需实机验收。

## 卸载

先停止 DSH，将 profile `package.json` 的 `dsh.profile.bundles` 和 `dependencies` 中的 `dsh-calendar-agent` 删除，移除 profile `node_modules/dsh-calendar-agent` 链接；恢复 qq-bridge 之前的 preset/模式，再启动服务。保留 `calendar-agent/` 数据以便恢复。Mac 停止并退出配套程序即可；删除专用日历请自行确认所需数据已备份。

MIT License。
