# 数据、同步与 hook

磁盘 `calendar.json` 的 schemaVersion 为 2，只保存月份索引；每月 `calendar/YYYY-MM.json` 包含 items 和 occurrences。HTTP/内存兼容结构仍为 schemaVersion 1。`items` 是按 ID 索引的对象，每项拥有 `revision`（从 1 开始）、`scheduleVersion`、`createdAt`、`updatedAt`、`deletedAt` 和可编辑字段：

```json
{
  "title": "晚间整理",
  "kind": "habit",
  "notes": "收拾桌面",
  "dueAt": "2026-10-12T22:00:00+08:00",
  "durationMinutes": 15,
  "timeZone": "Asia/Shanghai",
  "recurrence": { "frequency": "daily", "interval": 1 },
  "enabled": true,
  "status": "open"
}
```

kind 为 `todo | event | habit`；status 为 `open | done | cancelled`；非重复事项 recurrence 为 null。weekly 可以指定 weekdays（周一=1 到周日=7），interval 为 1..52，可选 until 为带时区日期。dueAt 落盘统一 UTC，重复规则在 timeZone 墙钟上计算。

`occurrences` 以 `itemId:scheduleVersion@dueAt` 索引，state 为 active / acknowledged / done / cancelled / superseded。事项改时间或重新开启会增加 scheduleVersion。完成习惯仅更新 occurrence；完成单次待办同时更新 item 的状态和 revision。

HTTP 只监听 127.0.0.1，所有端点均要求 `Authorization: Bearer TOKEN`，拒绝带 Origin 的浏览器请求。请求体上限 256 KiB。

| 方法和路径 | 输入/输出 |
| --- | --- |
| GET /v1/state | 当前时间、时区、星期、QQ 连接状态、items、occurrences 和 memory，包含删除记录；另含 syncBackend 与 icloud 状态，每项附只读 sync 状态 |
| POST /v1/reminder-preview | `{itemId?}`；调用真实 DSH Agent 预览正文，返回 text、agentSessionId、dryRun。省略 ID 使用临时示例；不写入待办、不发送 QQ |
| POST /v1/upsert | `{id, baseRevision, operationId, item}`；创建使用新 ID 与 baseRevision=0，编辑必须保留全部可编辑字段；返回保存事项及当前 sync 状态 |
| POST /v1/delete | `{id, baseRevision, operationId}`；保存删除记录，取消对应催促 |
| POST /v1/action | `{action: "complete" 或 "snooze" 或 "acknowledge", itemId, occurrenceKey?, minutes?}` |
| GET /v1/projections | 习惯展开数组；默认上个月、本月和下个月；可传 from/to ISO 日期，最大跨度 366 天 |
| GET /v1/icloud/status | enabled、running、lastSyncAt、lastError、pending、mapped、unsupported、conflicts |
| POST /v1/icloud/reload | `{}`；重新读取配置文件的 icloud 段；端口或 dataDir 变化须重启 |
| POST /v1/icloud/sync | `{}`；等待一轮手动同步，返回状态；HTTP 200 后仍须检查 lastError/conflicts |
| POST /v1/icloud/resolve | `{id, prefer: "local" 或 "remote"}`；显式解决普通事项冲突 |

状态码 400 输入错误、401 无令牌、403 浏览器请求、404 不存在、409 版本冲突、413 请求过大。upsert/delete 的 operationId 相同且请求一致时返回原结果；重用同一 operationId 提交不同数据返回 409。客户端必须先持久化 ID、operationId 和原请求，再发出请求，网络失败原样重试。删除 ID 不能重新创建，避免离线客户端复活已删除事项。MCP 允许不提供 ID/operationId 以便交互创建，但需要跨网络重试的同步客户端必须显式提供。

旧 Mac 客户端每 10 秒先重试已持久化请求，再读取服务器状态，上传本地变更（比较上一次实际展示的 revision），最后应用远端变更。冲突不静默覆盖。普通事件删除须连续两轮缺失；重复事件采用服务器投影。同步窗口与使用限制见 README。启用 iCloud 后，旧 Mac 应用请求返回 409，避免两个同步后端同时运行。

## iCloud 同步状态（0.2.0）

`state.json` 内的 `syncClients.icloud` 保存账户摘要与日历 URL 绑定、`maps`（UID/href/ETag/本地 revision/最后共同字段）、`pending`（发出前持久化的请求）、`conflicts`（冲突原因及远端副本）和最近状态。不含 Apple 密码；凭据独立保存于权限 600 的文件。导入事项和对应映射在同一存储事务提交。

单个同步循环串行执行：重试 pending → 三个月窗口的 VEVENT REPORT → 比较共同字段及本地 revision → 导入/排队写入 → 更新习惯投影 → 发出条件请求。PUT 创建用 If-None-Match: *，更新/删除用 If-Match: ETag；写入后 GET 校验。收到响应前崩溃时，下轮按 UID 与内容核验是否已经完成，避免重复创建。云端事件删除需连续两轮完整清单缺失且单独 GET 返回 404；请求失败或部分响应不作为删除证据。

默认每轮完成后等待 10 秒，失败退避最多 5 分钟；没有推送订阅或硬实时保证。普通事项在上个月、本月、下个月的窗口读取；原生重复、全天和会议邀请保留在云端而不导入。启用前须阅读 [iCloud 配置及迁移](ICLOUD_SETUP.md)。云端改期通过同一个 store.upsert 导入，因此会更新记忆、scheduleVersion，并取消旧 occurrence 及正在生成的旧提醒。

`syncWindow` 返回范围的时区、三个自然月、起点（含）和终点（不含）。窗口滚动不等于删除；已知事件消失需读取确认是否跨出边界，跨界改期完成一次后停止跟踪。未来/过去归档事项不自动同步。

事项返回的 `sync.state` 为 pending / synced / error / conflict / projection / unverified / archived。普通事项仅在 iCloud 映射已读回确认同一个 revision、没有待发送/缺失/冲突且同步服务状态正常时返回 synced；这个状态不代表设备端已刷新。upsert 的成功只保证 Linux 保存成功，回复用户应依据 sync 状态，不能把 pending 或 error 称为“已同步”。习惯多投影与旧 Mac 后端暂不提供逐版本云端确认。`sync`、`dueAtLocal` 都是只读字段，不要传进保存请求的 item；幂等重试保留原保存结果，其 sync 状态按查询时现状计算。

iCloud REPORT 中可能包含日历目录自身：目录 getetag 为 200，但 calendar-data 为 404。仅忽略与查询目录完全相同且符合此形态的元数据记录；任何真实事件的缺失内容或失败状态仍会中止整轮，避免误删。支持 calendar-data 的文本和 CDATA 表示。

## DSH hook 与记忆

DSH 插件暴露 Cordis hook：

- `calendar-agent/message(event)`：OneBot 收到消息后调度；内置监听器校验机器人 QQ、管理员私聊身份、消息时间与重放，再暂停催促。
- `calendar-agent/reminder-due(batch)`：持久化尝试后 await `ctx.parallel`；内置监听器创建 DSH Agent 回合，传入事项、历史及语气提示词，收集完成的模型正文，再经 OneBot 发送。batch.isCurrent 在生成和最终发送前核验回复及事项版本，任何相关变更取消整批旧稿。结果记录于 batch.result。
- `calendar-agent/reminded({deliveryId,count})`、`calendar-agent/acknowledged({count})`、`calendar-agent/delivery-failed({deliveryId})`：结果通知。

消息/到期 hook 有内置处理器，外部监听器是并行观察者，不是可靠的发送前 veto。不要用它们做额外发送，否则会重复通知。每次催促会调用 DSH 默认模型，使用无工具的独立 Agent 回合并在结束后释放运行实例；成功正文和 Agent session ID 存入共享记忆，对话 Agent 下一轮可见。

HTTP/内存 schemaVersion 仍为 1，包含可选 `memory`（最近 200 条事件）、`lastReplyId/lastReplyAt`；occurrence 包含 `sentCount/lastText`。磁盘布局为 v2：memory 和 lastText 来自独立 history.json，读取时合并到内存。旧文件自动迁移，原事项及确认状态保留。记忆是持久 JSON 加每轮上下文注入，不是模型参数训练；上下文包括最多 60 项当前事项、40 次 occurrence 和40条近期记忆，完整事项从 MCP 查询。模型失败不算成功发送。30秒为上次成功发送或失败结束后的最短重试间隔，避免慢请求结束后立即再催。

事项修改到未来会取消旧 occurrence，等待新时间；修改到过去则按新的逾期 occurrence 处理，不代表仍在使用旧时间。Mac 上传确认界面显示服务器确认的时间、时区和版本。最后一次核验之后已交给 QQ 的网络请求无法撤回。

整个存储只能有一个写入服务。MCP 和 Mac 都使用 HTTP API，不直接并发改 JSON。月度文件、历史和运行状态分开保存，事务日志与原子替换保证一致性，backup/ 保留上一版分文件快照；损坏时拒绝覆盖。进程锁不能代替跨机器分布式锁：不要让两台服务器共享同一个 dataDir。

0.1.2 增加受同一令牌保护的 `GET /v1/diagnostics`：返回本次进程启动以来各接口的请求计数、最后时间、状态码和成败计数。仅按 User-Agent 归为 mac/other，不把它作为身份认证依据；不记录令牌、请求体或事件内容。统计只保存在内存，重启清空。

磁盘目录、自动迁移及事务恢复见 [分月存储](STORAGE.md)。归档只限制云端同步；QQ 查询、共享记忆和已有提醒规则仍可以读取本地历史事项。
