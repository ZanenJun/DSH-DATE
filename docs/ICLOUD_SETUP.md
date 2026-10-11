# Linux 直接同步 iCloud 日历

本插件使用 Apple 提供的 App 专用密码认证，经 CalDAV HTTPS 直接访问 `caldav.icloud.com` 及发现的 Apple 日历分区服务器，包括中国区 `caldav.icloud.com.cn` / `pNN-caldav.icloud.com.cn`。全球入口发现中国区目录后会继续到该目录查询，无需手动修改地址。仅允许这些 CalDAV 主机及 HTTPS 443，不放开任意 iCloud 子域或第三方地址。协议实现采用 tsdav 和 ical.js；它们是开源协议库，并非 Apple 官方 SDK。未模拟 iCloud 网页登录，不保存浏览器 Cookie，也不需要 Apple 主密码。

Apple 文档：[第三方应用访问日历](https://support.apple.com/en-us/121539)、[生成 App 专用密码](https://support.apple.com/en-us/102654)。协议：[CalDAV RFC 4791](https://www.rfc-editor.org/rfc/rfc4791.html)。

## 配置

1. 在 iCloud 网页或 iPhone 系统日历中确认已有专用的「DSH 日历助手」，必须位于 iCloud 账户下。仅“在我的 Mac 上”的日历无法由服务器访问。
2. 开启 Apple 账户双重认证。在 `https://account.apple.com` 的“登录与安全 → App 专用密码”生成一个仅供 DSH-DATE 使用的密码。
3. 在 Linux 项目目录运行（DSH_HOME 使用你的实际路径）：

   ```bash
   export DSH_HOME=/path/to/your/dsh-home
   node bin/calendar.js icloud-setup
   ```

4. 输入账户邮箱和专用密码，密码输入不回显。命令只读发现日历，选择专用日历后保存配置并启用同步。发现失败不会保存配置。无需把任何密码发到聊天里。
5. 退出旧「DSH 日历同步」Mac 应用。新后端启用后会拒绝旧客户端，避免两个写入链路并行。iPhone / Mac 系统日历继续使用各自的 iCloud 同步，无需 SSH 隧道。

凭据仅存 `dataDir/icloud-credentials.json`，文件权限 600；不进入日历 JSON、MCP 返回或模型上下文。配置中的 `icloud` 为：

```json
{
  "enabled": true,
  "intervalMs": 20000,
  "credentialsFile": "./data/icloud-credentials.json",
  "calendarUrl": "https://p12-caldav.icloud.com/ACCOUNT/calendars/CALENDAR/"
}
```

日历地址必须由实际账户发现，不要直接复制示例。账户和日历绑定持久化，换账号或换整本日历不会自动套用旧映射。

### 配置失败时

配置向导会显示失败阶段、HTTP 状态或网络错误码，不显示密码、账户路径或 Apple 响应正文。HTTP 401 表示认证被拒，需核对 Apple 账户与对应专用密码；403 表示访问被拒；DNS、超时和 TLS 错误分别提示。若提示“未能解析或发现日历”或“尚未支持的地址”，将错误文本交给维护者检查兼容性，不要把凭据发到聊天里。旧版统一显示“无法连接 iCloud”，不能仅凭该提示判断是断网。

## 运行状态与冲突

```bash
node bin/calendar.js icloud-status
node bin/calendar.js icloud-sync
node bin/calendar.js icloud-resolve ITEM_ID --prefer remote
node bin/calendar.js icloud-resolve ITEM_ID --prefer local
```

`lastSyncAt` 为最近完成同步轮次；`pending` 为尚未完成的云端写入；`conflicts` 为暂停自动覆盖的事项；`unsupported` 为专用日历中尚不支持的事件数。`lastError` 非空表示最近轮次未完成，JSON 数据仍保留。连续失败逐步退避至最多 5 分钟间隔；`icloud-sync` 可手动发起重试。

普通事件冲突时，local 选择 Linux 当前版本，remote 选择当前 iCloud 版本；两者都重新读取云端 ETag，条件写入防止再次覆盖并发变更。复杂格式或旧投影清理冲突保留数据，需要先恢复事件格式后由维护者处理。已删除本地事项不会自动复活。

## 数据规则与边界

- 普通事件：标题、备注、开始时间、时长、时区双向同步；iCloud 新建事件作为待办导入。JSON 完成/暂停状态继续由 QQ 管理，云端标题展示相应标记。
- 只读取上个月、本月和下个月，按服务器配置时区计算月初边界，并在 CalDAV REPORT 中发送 time-range。原生重复、全天事件、会议邀请和无法识别的时区不导入，已有映射遇到不支持的变更会进入冲突。
- 习惯：规则与执行状态保存在 habits.json，只通过 hook 调用 Agent 提醒，不创建日历事件；确认/完成仅影响当次。每日必做模板保存在 daily-tasks.json，每天 08:00 生成的普通待办才参与日历同步。
- 本地修改立即改变 Linux 提醒时间；云端修改在成功拉取后取消旧提醒。网络断开时服务器只能基于最后已知状态提醒，无法知道尚未上传/拉取的改期。
- 窗口内报告不完整、网络异常、鉴权失败不会当成删除。远端删除需两轮完整窗口扫描，并通过 GET 404 确认；GET 发现原事件只是改期到窗口外时，导入这次改期后归档，不当成删除；本地删除使用 ETag 条件请求。
- 云端写入前持久化请求，重启后先读回确认，避免丢失 HTTP 响应导致重复创建。网络操作期间本地发生新修改会保留新版本，在下一轮同步。
- 轮询每轮结束后等待配置的间隔，默认 20 秒。每批最多处理 20 个待发送操作；首次同步大量事项或清理旧投影可能需要多轮，API 限流或设备离线时延迟会更长。

窗口外事件和旧习惯投影保留，不主动读取或删除；待重试请求移出窗口后暂停，记录在 `deferredPending`。未来事项进入窗口后才开始同步。跨出窗口的已知事项保留一次必要的 GET/PUT 以完成改期，避免旧时间留在任一端。

日历按月存放、对话历史单独保存，目录与事务恢复详见 [分月存储](STORAGE.md)。

## 从 Mac 同步迁移

保留当前专用日历和服务器 JSON。旧普通事件带 `dshcalendar://item/ID` 标记时，内容一致会接管原事项；两边不一致则列为冲突。未带映射标记的普通事件按 iCloud UID 导入，不按标题猜测同一事项。0.4.0 起不再生成习惯投影；当前三个月内已有本插件映射、且未被手动修改的旧习惯副本按版本安全清理。云端手动改动保留并列为冲突；未映射的旧投影和窗口外历史保留，不根据标题猜测并删除。

首次实机验收：iPhone 新建一个未来事项 → Linux 出现 → iPhone 改期 → JSON 时间更新并取消旧提醒 → QQ 改标题 → 系统日历更新 → 删除普通事件，两轮后 Linux 保存删除记录。还需测试账号自身的权限、Apple 服务兼容性和真正的双向同步；模拟协议测试不能替代这些步骤。
