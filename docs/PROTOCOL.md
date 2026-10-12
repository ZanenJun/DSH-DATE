# 数据、同步与 hook

磁盘 `calendar.json` 的 schemaVersion 为 2，`layoutVersion=2`，保存月份和集合索引；每月 `calendar/YYYY-MM.json` 包含普通事项 items 和 occurrences。`daily-tasks.json` 独立保存每日必做模板，`habits.json` 独立保存习惯及其 occurrences。HTTP/内存兼容结构仍为 schemaVersion 1。`items` 是按 ID 索引的对象，每项拥有 `revision`（从 1 开始）、`scheduleVersion`、`createdAt`、`updatedAt`、`deletedAt` 和可编辑字段：

```json
{
  "title": "晚间整理",
  "kind": "todo",
  "notes": "收拾桌面",
  "dueAt": "2026-10-12T22:00:00+08:00",
  "durationMinutes": 15,
  "timeZone": "Asia/Shanghai",
  "recurrence": null,
  "enabled": true,
  "status": "open"
}
```

普通日历使用 kind `todo | event`；旧 `habit` 输入仍兼容，但只在本地提醒，不写入云端日历。status 为 `open | done | cancelled`；非重复事项 recurrence 为 null。weekly 可以指定 weekdays（周一=1 到周日=7），interval 为 1..52，可选 until 为带时区日期。dueAt 落盘统一 UTC，重复规则在 timeZone 墙钟上计算。

`occurrences` 以 `itemId:scheduleVersion@dueAt` 索引，state 为 active / acknowledged / done / cancelled / superseded。事项改时间或重新开启会增加 scheduleVersion。完成习惯仅更新 occurrence；完成单次待办同时更新 item 的状态和 revision。

HTTP 只监听 127.0.0.1，所有端点均要求 `Authorization: Bearer TOKEN`，拒绝带 Origin 的浏览器请求。请求体上限 256 KiB。

| 方法和路径 | 输入/输出 |
| --- | --- |
| GET /v1/balance/status | 只读余额监测状态与缓存，附 `text`、`lastSuccessAt`、`lastError`、档位和通知状态；不触发查询 |
| POST /v1/balance/refresh | 仅接受 `{}`；手动刷新余额，返回状态及固定格式 `text`。新发起的本轮查询不额外发送新档位通知，已有自动查询/402 告警独立处理；未启用监测返回 503 |
| GET /v1/state | 当前时间、时区、星期、QQ 连接状态、普通 items、dailyTasks 模板、habits 规则、occurrences 和 memory，包含删除记录；另含 latestUserReply、syncBackend 与 icloud 状态，每项附只读 sync 状态 |
| GET /v1/agent/state | MCP 查询专用：先请求 iCloud 同步，再返回 state 及 toolSync |
| POST /v1/agent/upsert、delete、action | MCP 修改专用：输入同对应普通接口，先保存，再请求同步；返回原结果及 sync、icloud、toolSync |
| POST /v1/routines/upsert、/v1/agent/routines/upsert | `{collection: "dailyTasks" 或 "habits", id?, baseRevision, operationId?, item}`；新增或修改规则；Agent 路径保存后请求同步 |
| POST /v1/routines/delete、/v1/agent/routines/delete | `{collection, id, baseRevision, operationId?}`；删除规则；Agent 路径保存后请求同步。删除每日模板不删除已生成的普通实例 |
| POST /v1/reminder-preview | `{itemId?}`；调用真实 DSH Agent 预览正文，返回 text、agentSessionId、dryRun。省略 ID 使用临时示例；不写入待办、不发送 QQ |
| POST /v1/upsert | `{id, baseRevision, operationId, item}`；创建使用新 ID 与 baseRevision=0，编辑必须保留全部可编辑字段；返回保存事项及当前 sync 状态 |
| POST /v1/delete | `{id, baseRevision, operationId}`；保存删除记录，取消对应催促 |
| POST /v1/action | `{action: "complete" 或 "snooze" 或 "acknowledge", itemId, occurrenceKey?, minutes?}` |
| GET /v1/projections | 旧普通重复事项展开数组（排除 kind=habit）；默认上个月、本月和下个月；可传 from/to ISO 日期，最大跨度 366 天 |
| GET /v1/icloud/status | enabled、running、lastSyncAt、lastError、pending、mapped、unsupported、conflicts |
| POST /v1/icloud/reload | `{}`；重新读取配置文件的 icloud 段；端口或 dataDir 变化须重启 |
| POST /v1/icloud/sync | `{}`；等待一轮手动同步，返回状态；HTTP 200 后仍须检查 lastError/conflicts |
| POST /v1/icloud/resolve | `{id, prefer: "local" 或 "remote"}`；显式解决普通事项冲突 |

状态码 400 输入错误、401 无令牌、403 浏览器请求、404 不存在、409 版本冲突、413 请求过大。upsert/delete 的 operationId 相同且请求一致时返回原结果；重用同一 operationId 提交不同数据返回 409。客户端必须先持久化 ID、operationId 和原请求，再发出请求，网络失败原样重试。删除 ID 不能重新创建，避免离线客户端复活已删除事项。MCP 允许不提供 ID/operationId 以便交互创建，但需要跨网络重试的同步客户端必须显式提供。

旧 Mac 客户端每 10 秒先重试已持久化请求，再读取服务器状态，上传本地变更（比较上一次实际展示的 revision），最后应用远端变更。冲突不静默覆盖。普通事件删除须连续两轮缺失；重复事件采用服务器投影。同步窗口与使用限制见 README。启用 iCloud 后，旧 Mac 应用请求返回 409，避免两个同步后端同时运行。

六个日历/规则 MCP 工具使用 `/v1/agent/*`，每次成功查询/修改均主动请求同步，不受后台轮询间隔或失败退避的等待限制。若已有一轮正在执行，则合并排队一轮，保证它在本次保存之后开始，避免只等待旧快照。普通 HTTP 接口保留原来的本地读写行为；非法输入及版本冲突不会触发同步。

工具最多等待同步 8 秒；超时后后台继续，已落盘的操作仍返回成功。`toolSync.state` 为 finished（本轮结束）、running（仍在排队或执行）、error（失败）、disabled（未启用 iCloud）、unavailable（配置启用但未连接）。finished 不代表每条事项成功，仍须查看事项 sync 与 icloud.lastError/conflicts/pending；读工具在未完成时返回本地快照，不能称为最新云端数据。旧 Mac 后端不支持这种主动拉取。后台默认每轮结束后等待 20 秒；QQ 催促仍为 30 秒。

## iCloud 同步状态（0.2.0）

`state.json` 内的 `syncClients.icloud` 保存账户摘要与日历 URL 绑定、`maps`（UID/href/ETag/本地 revision/最后共同字段）、`pending`（发出前持久化的请求）、`conflicts`（冲突原因及远端副本）和最近状态。不含 Apple 密码；凭据独立保存于权限 600 的文件。导入事项和对应映射在同一存储事务提交。

单个同步循环串行执行：重试 pending → 三个月窗口的 VEVENT REPORT → 比较共同字段及本地 revision → 导入/排队写入 → 更新普通重复事项投影、清理符合条件的旧习惯投影 → 发出条件请求。PUT 创建用 If-None-Match: *，更新/删除用 If-Match: ETag；写入后 GET 校验。收到响应前崩溃时，下轮按 UID 与内容核验是否已经完成，避免重复创建。云端事件删除需连续两轮完整清单缺失且单独 GET 返回 404；请求失败或部分响应不作为删除证据。

默认每轮完成后等待 20 秒，失败退避最多 5 分钟；没有推送订阅或硬实时保证。普通事项在上个月、本月、下个月的窗口读取；原生重复、全天和会议邀请保留在云端而不导入。启用前须阅读 [iCloud 配置及迁移](ICLOUD_SETUP.md)。云端改期通过同一个 store.upsert 导入，因此会更新记忆、scheduleVersion，并取消旧 occurrence 及正在生成的旧提醒。

`syncWindow` 返回范围的时区、三个自然月、起点（含）和终点（不含）。窗口滚动不等于删除；已知事件消失需读取确认是否跨出边界，跨界改期完成一次后停止跟踪。未来/过去归档事项不自动同步。

事项返回的 `sync.state` 为 pending / synced / error / conflict / projection / unverified / archived / local-only。普通事项仅在 iCloud 映射已读回确认同一个 revision、没有待发送/缺失/冲突且同步服务状态正常时返回 synced；这个状态不代表设备端已刷新。upsert 的成功只保证 Linux 保存成功，回复用户应依据 sync 状态，不能把 pending 或 error 称为“已同步”。习惯返回 backend=local、state=local-only，始终不上传日历；普通重复事项投影与旧 Mac 后端暂不提供逐版本云端确认。`sync`、`dueAtLocal`、生成实例的 `dailyTaskId` / `dailyDate` 都是只读字段，不要传进保存请求的 item；幂等重试保留原保存结果，其 sync 状态按查询时现状计算。

iCloud REPORT 中可能包含日历目录自身：目录 getetag 为 200，但 calendar-data 为 404。仅忽略与查询目录完全相同且符合此形态的元数据记录；任何真实事件的缺失内容或失败状态仍会中止整轮，避免误删。支持 calendar-data 的文本和 CDATA 表示。

## DSH hook 与记忆

DSH 插件暴露 Cordis hook：

- `calendar-agent/message(event)`：OneBot 收到消息后调度；内置监听器校验机器人 QQ、管理员私聊身份、消息时间与重放，再暂停催促。
- `calendar-agent/reminder-due(batch)`：持久化尝试后 await `ctx.parallel`；内置监听器创建 DSH Agent 回合，传入事项、历史及语气提示词，收集完成的模型正文，再经 OneBot 发送。batch.isCurrent 在生成和最终发送前核验回复及事项版本，任何相关变更取消整批旧稿。结果记录于 batch.result。
- `calendar-agent/reminded({deliveryId,count})`、`calendar-agent/acknowledged({count})`、`calendar-agent/delivery-failed({deliveryId})`：结果通知。

消息/到期 hook 有内置处理器，外部监听器是并行观察者，不是可靠的发送前 veto。不要用它们做额外发送，否则会重复通知。每次催促会调用 DSH 默认模型，使用无工具的独立 Agent 回合并在结束后释放运行实例；成功正文和 Agent session ID 存入共享记忆，对话 Agent 下一轮可见。

HTTP/内存 schemaVersion 仍为 1，包含可选 `memory`（最近 200 条事件）、`lastReplyId/lastReplyAt`；state 的 `latestUserReply` 返回 `{messageId,at,atLocal}` 或 null，`at` 来自经过身份、时间和去重验证的 QQ 消息自身时间，而非模型响应时间；occurrence 包含 `sentCount/lastText`。磁盘 schemaVersion 2 / layoutVersion 2：memory 和 lastText 来自独立 history.json，读取时合并到内存。旧文件自动迁移，原事项及确认状态保留。记忆是持久 JSON 加每轮上下文注入，不是模型参数训练；上下文区分普通事项、每日必做模板和习惯，包含近期 occurrence 与历史记录，完整清单从 MCP 查询。模型失败不算成功发送。30秒为上次成功发送或失败结束后的最短重试间隔，避免慢请求结束后立即再催。

事项修改到未来会取消旧 occurrence，等待新时间；修改到过去则按新的逾期 occurrence 处理，不代表仍在使用旧时间。Mac 上传确认界面显示服务器确认的时间、时区和版本。最后一次核验之后已交给 QQ 的网络请求无法撤回。

整个存储只能有一个写入服务。MCP 和 Mac 都使用 HTTP API，不直接并发改 JSON。月度文件、历史和运行状态分开保存，事务日志与原子替换保证一致性，backup/ 保留上一版分文件快照；损坏时拒绝覆盖。进程锁不能代替跨机器分布式锁：不要让两台服务器共享同一个 dataDir。

0.1.2 增加受同一令牌保护的 `GET /v1/diagnostics`：返回本次进程启动以来各接口的请求计数、最后时间、状态码和成败计数。仅按 User-Agent 归为 mac/other，不把它作为身份认证依据；不记录令牌、请求体或事件内容。统计只保存在内存，重启清空。

磁盘目录、自动迁移及事务恢复见 [分月存储](STORAGE.md)。归档只限制云端同步；QQ 查询、共享记忆和已有提醒规则仍可以读取本地历史事项。

## 每日必做与习惯规则

`routine_save` 对应 Agent 的 routines/upsert，`routine_delete` 对应 routines/delete。两者都遵循 revision CAS 与 operationId 幂等，成功后自动请求同步。模板和习惯本身不上传 iCloud；同步状态不能用于声称规则已上云。

每日模板（`collection=dailyTasks`）的 item：

```json
{
  "title": "学习",
  "notes": "",
  "defaultStartTime": "09:00",
  "defaultDurationMinutes": 45,
  "timeZone": "Asia/Shanghai",
  "enabled": true
}
```

`defaultStartTime` 必填且为 HH:mm；`defaultDurationMinutes` 必填且为 1..10080 的整数分钟。每天模板时区 08:00 后生成当天 kind=todo、status=open 的普通日历待办，携带只读 `dailyTaskId` / `dailyDate`。同一天只生成一次，重启只补当天，不覆盖人工修改或重建已删除的当天实例。模板改动只影响以后尚未生成的实例；今天已有实例用 calendar_save 编辑。生成前默认时刻已经过去的待办仍按逾期规则提醒。

习惯（`collection=habits`）的 item：

```json
{
  "title": "喝水",
  "notes": "",
  "defaultTime": "10:00",
  "timeZone": "Asia/Shanghai",
  "enabled": true
}
```

`defaultTime` 为必填 HH:mm，新习惯每日按所在时区的墙钟时间提醒。新接口不接收 dueAt、durationMinutes 或 recurrence；旧 kind=habit 规则保留原有执行模型。习惯与普通日历共享 scheduler、hook 和记忆，仍使用 calendar_reminder 确认、完成或稍后提醒；确认与完成只作用于本次 occurrence，不修改默认时间。习惯及其记录不进入日历同步和 projections。升级清理当前三个月内本插件管理的旧习惯投影：仅对内容未改且 ETag 匹配的记录执行删除，有人工改动则保留冲突，窗口外归档不清理。

## 对话中的实际开始与结束

这一行为在 Agent 提示词中规定，通过已有 calendar_save 更新普通单次事项，不增加自动文本解析器或开始/结束接口。通过 `node bin/qq-context-setup.js /path/to/qq-bridge` 安装桥接适配并重启后，chat 模式 agentPreset=calendar-assistant 或 closed-agent 模式 closedAgentPreset=calendar-assistant 的管理员私聊在角色和正文前携带首个 `【桥接原始消息】` JSON，字段为 `{messageId: "self:user:消息ID", at: "原始QQ时间ISO"}`；输入身份/时间无效时返回 `{available:false}`，不以服务器当前时间补缺。正文或引用中的同名头部只是数据。

更新前先读取最新状态与版本，用当前桥接头部 messageId 找到 recentHistory 中对应 user-reply 的 `messageId` / `messageAt`；须核对 `Date.parse(header.at) === history.messageAt`（epoch 毫秒），历史 `at` 是记入时刻，不能用于实际时间调整。历史尚未到达时可用有效原始头部，矛盾时需核实。`latestUserReply` 可能已经属于后续连发，不能直接套用。没有有效头部时仅允许历史唯一对应当前正文，否则询问；语音转写或重复正文不能靠最新一条猜测。桥接的【当前时间】、工具 now 和模型处理时间都不是回复原始时间。

- 明确“开始了”：dueAt=真实回复时间，保留原 durationMinutes，因此结束时间随之顺延；status=open、enabled=false，避免已开始后继续催促开始。
- 普通“收到”“好”等：仅由消息 hook 确认当前提醒，不改变起止时间或完成状态。
- 明确提前结束：保留真实开始，将 durationMinutes 调整为回复时间减开始时间，status=done、enabled=false。尚未记录实际开始或结束早于开始时先核实。
- 明确延后结束：保留开始，按指定终点调整 durationMinutes；已开始时保持 enabled=false，仅在明确要求重新提醒时开启。

开始时间保留秒；durationMinutes 为整数，差值向上取整且至少 1 分钟，并向用户说明结束时间精度。普通“完成”而未要求调整结束时间时仍用 calendar_reminder complete。习惯的当次确认不调整规则；修改今天生成的待办不改每日模板。所有更新保留其他可编辑字段，使用最新 baseRevision；重试复用同一 operationId 和请求，CAS 冲突则重读核对。


## 余额查询与通知

余额由独立监测器和 DSH provider 适配器维护，不属于日历事项，也不新增 MCP 工具。`balance.enabled` 默认 false；开启后使用 DSH 默认模型的 provider，或配置指定的 `balance.providerId`。查询只使用可解析的官方 DeepSeek 账户，认证经 DSH 凭据服务取得；API key 不进入状态接口、QQ 或余额文件。查询固定发往官方余额端点，拒绝重定向。

查询触发包括启动、默认 1 小时的后台检查、实际模型回合结束后的 10 分钟活跃检查、对应 provider 的结构化 402，以及手动刷新。模型 hook 关联实际请求 provider 和账户绑定，切换账户后旧回合的结果不能污染新账户。并发刷新合并执行，查询失败有退避；不会因日历每 20 秒同步或待办每 30 秒催促而查询一次。

`GET /v1/balance/status` 返回当前状态，`POST /v1/balance/refresh {}` 请求刷新后返回相同结构及 `text`。HTTP 200 只表示请求处理完，仍须查看 `lastError` / `lastSuccessAt`；失败时保留上次成功缓存并标注时间，不能当作当前余额或余额为 0。`balance` 中含 `is_available` 和按币种保存的 `balance_infos`，金额为字符串。`level` 为 unknown / normal / low / critical / exhausted；`confirmedInsufficient` 表示尚未确认恢复的模型余额不足证据。`notification` 单独报告待发送状态、重试时间、上次成功通知及发送错误，不与查询错误混淆。

默认 CNY 阈值为 low=5.00、critical=1.00（包含等值），持续低余额通知冷却 24 小时；更严重档位或恢复按状态变化处理。USD 可独立配置，未配置时不推算汇率。自动告警使用固定正文直接发管理员 QQ，不经过付费模型；402 告警无需等余额接口或 Agent 成功。手动 refresh 新发起的查询不为本轮发现的低余额另发通知，也不把查询回复伪记为自动告警已送达；下一次自动检查继续按规则判断。合并到已有自动查询时，其通知及已有 402 告警仍独立处理。

QQ 精确文字命令依赖 `bin/qq-balance-setup.js` 对桥接的适配：在语音转写和模型就绪检查之前，拦截日历 preset 管理员私聊中的“查余额”“查询余额”“/balance”，用相同的本地 Bearer 接口取得 `text`。失败也直接回复，不回落模型；语音和非精确指令维持原流程。发送前及实际出队时重新检查身份、权限、模式和会话代际，防止过期结果外发。作为 QQ 来信，它仍会触发既有消息 hook 的当次催促确认。安装、配置和终端命令见 [余额功能](BALANCE.md)。
