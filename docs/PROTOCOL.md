# 数据、同步与 hook

`calendar.json` schemaVersion 为 1。`items` 是按 ID 索引的对象，每项拥有 `revision`（从 1 开始）、`scheduleVersion`、`createdAt`、`updatedAt`、`deletedAt` 和可编辑字段：

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
| GET /v1/state | 当前时间、时区、星期、QQ 连接状态、items 数组和 occurrences 数组，包含删除记录 |
| POST /v1/upsert | `{id, baseRevision, operationId, item}`；创建使用新 ID 与 baseRevision=0，编辑必须保留全部可编辑字段 |
| POST /v1/delete | `{id, baseRevision, operationId}`；保存删除记录，取消对应催促 |
| POST /v1/action | `{action: "complete" 或 "snooze" 或 "acknowledge", itemId, occurrenceKey?, minutes?}` |
| GET /v1/projections | 习惯展开数组；默认过去 7 天到未来 90 天；可传 from/to ISO 日期，最大跨度 366 天 |

状态码 400 输入错误、401 无令牌、403 浏览器请求、404 不存在、409 版本冲突、413 请求过大。upsert/delete 的 operationId 相同且请求一致时返回原结果；重用同一 operationId 提交不同数据返回 409。客户端必须先持久化 ID、operationId 和原请求，再发出请求，网络失败原样重试。删除 ID 不能重新创建，避免离线客户端复活已删除事项。MCP 允许不提供 ID/operationId 以便交互创建，但需要跨网络重试的同步客户端必须显式提供。

Mac 客户端每 10 秒先重试已持久化请求，再读取服务器状态，上传本地变更（比较上一次实际展示的 revision），最后应用远端变更。冲突不静默覆盖。普通事件删除须连续两轮缺失；重复事件采用服务器投影。同步窗口与使用限制见 README。

DSH 插件暴露 Cordis hook：

- `calendar-agent/message(event)`：OneBot 收到消息后调度；内置监听器校验机器人 QQ、管理员私聊身份、消息时间与重放，再暂停催促。
- `calendar-agent/reminder-due(batch)`：调度器持久化尝试后 await `ctx.parallel`，内置监听器调用 OneBot 发送，结果记录于 batch.result。
- `calendar-agent/reminded({deliveryId,count})`、`calendar-agent/acknowledged({count})`、`calendar-agent/delivery-failed({deliveryId})`：结果通知。

消息/到期 hook 有内置处理器，外部监听器是并行观察者，不是可靠的发送前 veto。不要用它们做额外发送，否则会重复通知。业务提醒直接由 hook 发送，不会为了每次催促额外调用模型。

整个存储只能有一个写入服务。MCP 和 Mac 都使用 HTTP API，不直接并发改 JSON。文件原子替换并同步到磁盘，备份上一份 JSON；损坏时拒绝覆盖。进程锁不能代替跨机器分布式锁：不要让两台服务器共享同一个 dataDir。

0.1.2 增加受同一令牌保护的 `GET /v1/diagnostics`：返回本次进程启动以来各接口的请求计数、最后时间、状态码和成败计数。仅按 User-Agent 归为 mac/other，不把它作为身份认证依据；不记录令牌、请求体或事件内容。统计只保存在内存，重启清空。
