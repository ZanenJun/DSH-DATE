# DSH-DATE · 日历与待办助手

独立的 DeepSeek Harness 插件：在 QQ 私聊中管理日历、待办和习惯；Linux 保存 JSON 并通过 hook 提醒；macOS 自带「日历」通过配套程序每 10 秒同步。

**兼容版本：** Linux、Node.js ≥ 22.13、DSH `0.2.0-rc.2`、OneBot v11（已对接 SnowLuma）。Mac 配套程序需要 macOS 14+ 和 Xcode Command Line Tools。Linux 自动测试及真实 DSH 工具调用已验证；Mac 已有用户完成构建和连接，最新同步修复仍需实机验收。

## 行为

- 用 QQ 说“明天 9 点提醒我开会”“每天 22 点提醒我整理房间”“每周一、三 19 点运动”。时间不明确时助手会询问。
- 到点通过 `calendar-agent/reminder-due` hook 给配置的管理员 QQ 发私聊；无回复约每 30 秒重复一次，合并到期事项。每次最多 20 项，轮转避免遗漏。
- 管理员的**任何私聊回复**通过 `calendar-agent/message` hook 暂停所有已提醒事项的当次催促；不会自动标记完成。
- 明确说“完成 + 事项”才标记完成。只有一个待确认事项时“完成”也可；有多个时助手应询问。习惯只完成当次，下一次照常提醒。
- “稍后 10 分钟”恢复为延后提醒。修改计划时间会取消旧提醒。
- JSON 保存事项、重复规则、每次提醒状态、版本和删除记录。重启不丢失暂停/完成状态。停机跨过多个习惯周期只补最近一次。
- QQ 断开、回复监听断开时暂停发送并重试。提醒不依赖模型调用，聊天及完成语义理解依赖模型 API。
- Mac 使用专用「DSH 日历助手」日历。普通待办/事件的标题、备注、起止时间和时区双向同步；Mac 新建事件作为待办上传。删除经两次同步确认后上传。完成显示 `✓`，完成操作请通过 QQ。
- 习惯及重复事项只向 Mac 展示过去 7 天到未来 90 天的事件（`↻`）；其修改、删除会在下次同步恢复。**请在 QQ 修改习惯规则**。全天事件、Mac 创建的重复事件不支持导入。
- Mac 同时修改已在服务器变化的事项会保留冲突，不覆盖。应用内“保留本地副本，并采用服务器版本”会先把 Mac 版本复制到另一日历，再更新为服务器版本。

## Mac：通过 Git 安装和更新

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

MCP 只在标准输出传协议消息；工具为 `calendar_list`、`calendar_save`、`calendar_delete`、`calendar_reminder`。独立使用时先运行 `node bin/calendar.js serve` 启动数据服务，不能只启动 stdio 客户端。DSH 内的名字加前缀 `mcp__calendar__`。

## Mac 接入

详见 [Mac 安装说明](docs/MAC_SETUP.md)。通过上面的 Git 命令安装应用，填回环地址与配对令牌，授予**完整日历访问权限**，点击开启同步。同步需要应用保持运行；Mac 休眠或离线期间暂停，恢复后继续。服务器提醒独立运行，不受 Mac 是否在线影响。

API 只监听 Linux 的 `127.0.0.1:3217`。建议从 Mac 建立 SSH 隧道，不要将端口直接暴露公网：

```bash
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -L 127.0.0.1:3217:127.0.0.1:3217 YOUR_USER@YOUR_SERVER
```

令牌存于 Linux 数据目录的 `access-token`（600），Mac 存钥匙串。分享安装包不包含令牌、QQ 号、API key 或个人日历数据。

## 数据和同步协议

见 [协议及 hook](docs/PROTOCOL.md)。主要数据为 `data/calendar.json`，自动保留前一次提交的 `.backup`。单进程拥有写锁，所有写入排队、先写临时文件再原子替换。不要在服务运行时直接改 JSON。手动修复前停止 DSH、备份整个数据目录，再编辑或恢复。

项目为个人单用户、小规模日历设计；历史和幂等记录当前不自动清理。默认时区 Asia/Shanghai；按日历墙钟计算每日/每周重复，支持夏令时。精确执行时间受服务器调度、网络和 QQ 平台影响。消息已被 QQ 接收但写盘前崩溃时，恢复后可能重复一次，不承诺恰好一次发送。

Mac 初次导入扫描过去 1 年到未来 5 年的非重复事件。习惯展开范围独立为过去 7 天到未来 90 天。专用日历丢失或权限撤回时停止同步，不把整本日历丢失当成“删除所有事项”。无法保证 EventKit/iCloud 的标识符在所有迁移情况下稳定，换 Mac/迁移账户前请备份同步记录。

## 开发与测试

```bash
npm ci
npm run check
npm test
npm pack
```

测试覆盖真实 stdio MCP 握手与工具调用、API 鉴权、CAS 冲突/幂等/删除、30 秒催促、回复身份与重放、延后、习惯周期、夏令时、重启和损坏数据。测试使用临时目录和模拟 QQ，不给真人发测试消息。真实 DSH 验证只读查询；Mac 编译及 EventKit 联调需在 Mac 完成。

## 卸载

先停止 DSH，将 profile `package.json` 的 `dsh.profile.bundles` 和 `dependencies` 中的 `dsh-calendar-agent` 删除，移除 profile `node_modules/dsh-calendar-agent` 链接；恢复 qq-bridge 之前的 preset/模式，再启动服务。保留 `calendar-agent/` 数据以便恢复。Mac 停止并退出配套程序即可；删除专用日历请自行确认所需数据已备份。

MIT License。
