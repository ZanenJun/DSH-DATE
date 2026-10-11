# macOS 自带日历接入

此应用使用 Apple EventKit，只能在 Mac 运行。当前通过 Git 提供源码和本机构建脚本；已有用户完成构建和连接，最新同步修复仍需实机验收，应用未经过 Apple 签名公证。支持 macOS 14 或更高版本；Apple 芯片和 Intel 均按当前机器架构编译。

1. 如果尚无开发工具，在 Mac 终端运行 `xcode-select --install`，在系统窗口完成安装。
2. 首次安装执行：

   ```bash
   git clone https://github.com/ZanenJun/DSH-DATE.git ~/DSH-DATE
   bash ~/DSH-DATE/mac/update.sh
   ```

   以后只运行 `bash ~/DSH-DATE/mac/update.sh` 即可更新。程序安装在 `~/Applications/DSH 日历同步.app`；源码有未提交修改时脚本会停止。旧版压缩包用户按同样步骤迁移，保留原同步记录和钥匙串。只构建不安装可运行 `bash ~/DSH-DATE/mac/build.sh`。

3. 脚本会打开安装好的应用。首次点击“授权并开启同步”时，系统会询问日历访问权限，允许完整访问。权限可在「系统设置 → 隐私与安全性 → 日历」管理。应用仅同步它创建并记录标识的专用日历。
4. 另开终端保持 SSH 隧道运行（将用户名与服务器地址替换成你自己的）：

   ```bash
   ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
     -L 127.0.0.1:3217:127.0.0.1:3217 USER@SERVER
   ```

5. Linux 服务器上在插件目录执行 `DSH_HOME=/your/dsh-home node bin/calendar.js pair --show-token`，复制配对令牌。不要把它发到 QQ 或分享给别人。
6. 应用填写 `http://127.0.0.1:3217` 和令牌，点击开启同步。令牌存钥匙串，不写入普通配置文件。完整同步之后显示最近同步时间，每 10 秒重复。
7. 在 QQ 新增一个时间明确的待办，等待约 10 秒，在系统「日历」中勾选「DSH 日历助手」查看。修改这个事件的标题或时间，再等约 10 秒，让 QQ 助手列出待办检查是否更新。

待办在 Apple 日历中以事件表现，不是 Apple「提醒事项」的复选框。完成请在 QQ 说“完成 + 事项”，Mac 将显示 `✓`。编辑标题不等于更改完成状态。习惯事件带 `↻`，只是展示；规则通过 QQ 管理，不在 Mac 设置重复规则。

双端同时编辑冲突时，应用会保留待处理项。点击“保留本地副本，并采用服务器版本”后，本地版本保存到「DSH 同步冲突副本」日历，不会再次上传；主日历采用服务器版本。

应用关闭、Mac 休眠或 SSH 断开时不能保持每 10 秒同步；再次开启/唤醒后恢复。可将应用加入 Mac 的登录项，但每次启动仍需点击开启同步，并保持 SSH 连接。服务器上的 QQ 提醒不受此影响。

本地状态位于 `~/Library/Application Support/DSHCalendarSync/state.json`。不要删除它来“重置同步”，它包含事件映射、冲突和未完成请求。更换服务器或重建日历前先备份，避免重复导入。请勿修改专用事件的 URL；它用于识别事件及崩溃恢复。

首次 Mac 验收建议：QQ 新建 → Mac 出现 → Mac 改时间 → QQ 查询更新 → 两端同时编辑出现冲突 → 保留副本解决 → Mac 删除普通事件后约 20 秒内同步删除。另验证习惯展开和暂停/完成后的显示。提醒计时由 Linux 自动测试覆盖；可自行新增“一分钟后提醒我测试”做最终 QQ 实测。

Apple 接口参考：[完整日历访问](https://developer.apple.com/documentation/eventkit/ekeventstore/requestfullaccesstoevents(completion:))、[日历权限说明字段](https://developer.apple.com/documentation/bundleresources/information-property-list/nscalendarsfullaccessusagedescription)。

## 从 0.1.0 更新到 0.1.1

0.1.1 将同步轮询从 60 秒改为 10 秒。先退出旧应用，再解压新版源码，在包含 build.sh 的目录执行 `bash build.sh`，打开新生成的应用，点击开启同步。若之前将应用复制到「应用程序」，用新生成的版本替换旧版。保留原有同步记录和钥匙串，避免重新导入。主界面显示“每 10 秒同步一次”即为新版。

10 秒是轮询间隔。上一轮尚未完成时不会并发启动下一轮；离线、休眠或网络缓慢时可能超过 10 秒。普通事件删除仍需两轮确认，正常连接时约 10–20 秒。

## 0.1.2：显示扫描结果并刷新日历缓存

若程序显示最近同步成功，但服务器仍为空，请更新至 0.1.2。每轮同步会先释放 EventKit 缓存对象、刷新来源，并重新按已保存的日历标识获取日历，再查询事件。该调整针对 Calendar.app 外部编辑后对象缓存可能过期的情况，不代表所有“空清单”问题都已确认由缓存造成。

界面现在显示日历名称、账户、标识末尾、扫描事件数、全天/重复事件数、服务器事项数，以及本轮成功上传次数。同名日历或带旧同步标记却没有服务器记录的事件会单独提示。若仍未同步，把这些文字和错误信息发给维护者；无需发送令牌或完整本地状态文件。

先退出旧应用，再使用新源码编译并打开；保留原有 state.json 和钥匙串。修复效果需要在 Mac 上对真实事件验收。

Apple 文档：[日历变化通知与重新获取对象](https://developer.apple.com/documentation/EventKit/updating-with-notifications)、[刷新日历来源](https://developer.apple.com/documentation/eventkit/ekeventstore/refreshsourcesifnecessary())。

## 0.1.3：改期确认与保护本地编辑

上传后显示“服务器已确认：事项 → 日期时间、时区、版本”。请以此确认改期实际上传的值；改到已经过去的时间会生成新的逾期提醒。拉取时跳过无变化的事件，并在写入前刷新检查本地快照：HTTP 请求期间发生的新编辑留到下一轮上传，避免旧响应覆盖它。通过 `bash ~/DSH-DATE/mac/update.sh` 更新后重新开启同步，保持 SSH 隧道运行。
