import SwiftUI
import EventKit
import Security
import AppKit

typealias Object = [String: Any]
func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
func decode(_ data: Data) throws -> Object {
    guard let value = try JSONSerialization.jsonObject(with: data) as? Object else { throw failure("返回的数据不是 JSON 对象") }
    return value
}
func failure(_ text: String) -> NSError { NSError(domain: "DSHCalendar", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }
func stamp(_ date: Date) -> String { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f.string(from: date) }
func date(_ value: Any?) throws -> Date {
    guard let value = value as? String else { throw failure("日期缺失") }
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: value) { return d }; f.formatOptions = [.withInternetDateTime]
    guard let d = f.date(from: value) else { throw failure("日期格式错误") }; return d
}
func keychain(_ value: String? = nil) throws -> String {
    let query: Object = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "org.dsh.calendar-sync", kSecAttrAccount as String: "sync-token"]
    if let value = value {
        let data = Data(value.utf8)
        let result = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if result == errSecItemNotFound {
            var q = query; q[kSecValueData as String] = data
            guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw failure("无法保存钥匙串令牌") }
        } else if result != errSecSuccess { throw failure("无法更新钥匙串令牌") }
        return value
    }
    var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return "" }
    return String(data: data, encoding: .utf8) ?? ""
}
struct APIError: Error { let status: Int; let message: String }

@MainActor final class SyncModel: ObservableObject {
    @Published var endpoint = UserDefaults.standard.string(forKey: "endpoint") ?? "http://127.0.0.1:3217"
    @Published var token = ""
    @Published var status = "填写连接信息，然后开启同步。"
    @Published var running = false
    @Published var busy = false
    @Published var starting = false
    @Published var conflictCount = 0
    @Published var details = "尚未扫描日历。"
    private let store = EKEventStore()
    private var timer: Timer?
    private var state: Object = [:]
    private let stateURL: URL
    private var calendar: EKCalendar?
    private var savedToken = ""
    private var resolving = false
    private var uploadsThisCycle = 0
    init() {
        stateURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("DSHCalendarSync/state.json")
        do {
            if FileManager.default.fileExists(atPath: stateURL.path) { state = try decode(Data(contentsOf: stateURL)) }
            savedToken = try keychain(); token = savedToken
        } catch { status = "无法读取本地同步记录：\(error.localizedDescription)"; state["broken"] = true }
    }
    func persist() throws {
        try FileManager.default.createDirectory(at: stateURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try json(state).write(to: stateURL, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stateURL.path)
    }
    func request(_ route: String, _ body: Object? = nil) async throws -> Object {
        guard let base = URL(string: endpoint), let host = base.host,
              base.scheme == "https" || (base.scheme == "http" && ["127.0.0.1", "localhost", "::1"].contains(host)),
              base.user == nil, base.password == nil, base.query == nil, base.fragment == nil else { throw failure("使用 HTTPS 地址或 SSH 隧道的本地地址") }
        var r = URLRequest(url: base.appendingPathComponent("v1/" + route)); r.timeoutInterval = 15
        r.setValue("Bearer " + savedToken, forHTTPHeaderField: "Authorization")
        r.setValue("DSHCalendarSync/0.1.2", forHTTPHeaderField: "User-Agent")
        if let body = body { r.httpMethod = "POST"; r.httpBody = try json(body); r.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await URLSession.shared.data(for: r)
        guard let response = response as? HTTPURLResponse else { throw failure("服务器未响应") }
        let object = try decode(data)
        guard response.statusCode == 200 else { throw APIError(status: response.statusCode, message: object["error"] as? String ?? "请求失败") }
        return object
    }
    func start() async {
        guard !running && !busy && !starting else { return }
        starting = true
        defer { starting = false }
        do {
            if state["broken"] as? Bool == true { throw failure("同步记录损坏，请备份并修复 state.json，不能直接覆盖") }
            if let bound = state["endpoint"] as? String, bound != endpoint { throw failure("本地日历已绑定另一地址。请先恢复原地址；迁移前备份同步记录。") }
            let candidate = token.trimmingCharacters(in: .whitespacesAndNewlines)
            guard candidate.count >= 32 else { throw failure("请填写服务器配对令牌") }
            savedToken = try keychain(candidate)
            guard try await store.requestFullAccessToEvents() else { throw failure("需要完整日历访问权限才能双向同步") }
            _ = try await request("state")
            calendar = try obtainCalendar()
            state["endpoint"] = endpoint; try persist()
            UserDefaults.standard.set(endpoint, forKey: "endpoint")
            running = true
            timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in Task { @MainActor in await self?.sync() } }
            await sync()
        } catch { status = describe(error) }
    }
    func stop() { timer?.invalidate(); timer = nil; running = false; status = "已暂停；正在进行的同步会完成。" }
    func describe(_ error: Error) -> String {
        if let e = error as? APIError { return "服务器 \(e.status)：\(e.message)" }
        return error.localizedDescription
    }
    func obtainCalendar() throws -> EKCalendar {
        if let id = state["calendarId"] as? String {
            guard let c = store.calendar(withIdentifier: id), c.allowsContentModifications else { throw failure("专用日历不存在或不可写。请恢复日历；不会把它解释为删除全部待办。") }
            return c
        }
        let c = EKCalendar(for: .event, eventStore: store); c.title = "DSH 日历助手"
        c.source = store.sources.first(where: { $0.sourceType == .local }) ?? store.defaultCalendarForNewEvents?.source
        guard c.source != nil else { throw failure("没有可写日历来源，请先在系统日历中启用一个日历账户") }
        try store.saveCalendar(c, commit: true)
        state["calendarId"] = c.calendarIdentifier; try persist(); return c
    }
    func refreshedCalendar() throws -> EKCalendar {
        guard let id = state["calendarId"] as? String else { throw failure("尚未绑定专用日历") }
        // Every EventKit write is committed immediately. No unsaved event is retained across cycles.
        // Drop cached objects so Calendar.app edits are read using a fresh EKCalendar and event query.
        store.reset()
        store.refreshSourcesIfNecessary()
        guard let c = store.calendar(withIdentifier: id), c.allowsContentModifications else {
            throw failure("已绑定的专用日历不存在或不可写；不会自动换日历或删除服务器数据。")
        }
        calendar = c
        return c
    }
    func snapshot(_ e: EKEvent) -> Object {
        ["title": e.title ?? "", "notes": e.notes ?? "", "dueAt": stamp(e.startDate),
         "durationMinutes": max(1, Int(e.endDate.timeIntervalSince(e.startDate) / 60)),
         "timeZone": e.timeZone?.identifier ?? TimeZone.current.identifier]
    }
    func same(_ a: Object, _ b: Object) -> Bool { (try? json(a)) == (try? json(b)) }
    func event(_ map: Object, in c: EKCalendar) -> EKEvent? {
        guard let id = map["eventId"] as? String, let e = store.event(withIdentifier: id), e.calendar.calendarIdentifier == c.calendarIdentifier else { return nil }
        return e
    }
    func fill(_ e: EKEvent, from item: Object, id: String, projected: Bool = false) throws {
        let done = item["status"] as? String == "done" || item["state"] as? String == "done"
        let disabled = item["enabled"] as? Bool == false || item["status"] as? String == "cancelled"
        e.title = (done ? "✓ " : disabled ? "⏸ " : projected ? "↻ " : "") + (item["title"] as? String ?? "未命名")
        e.notes = item["notes"] as? String ?? ""; e.startDate = try date(item["dueAt"])
        e.endDate = e.startDate.addingTimeInterval(Double(item["durationMinutes"] as? Int ?? 30) * 60)
        e.timeZone = TimeZone(identifier: item["timeZone"] as? String ?? "Asia/Shanghai")
        e.isAllDay = false; e.recurrenceRules = nil; e.alarms = nil
        var u = URLComponents(); u.scheme = "dshcalendar"; u.host = projected ? "occurrence" : "item"; u.path = "/" + id; e.url = u.url
    }
    func write(_ id: String, route: String, body: Object, map: Object) async throws -> Object? {
        var pending = state["pending"] as? Object ?? [:]
        pending[id] = ["route": route, "body": body, "map": map]; state["pending"] = pending; try persist()
        return try await replay(id)
    }
    func replay(_ id: String) async throws -> Object? {
        var pending = state["pending"] as? Object ?? [:]
        guard let op = pending[id] as? Object, let route = op["route"] as? String, let body = op["body"] as? Object else { return nil }
        do {
            let result = try await request(route, body)
            uploadsThisCycle += 1
            var maps = state["maps"] as? Object ?? [:]; var map = op["map"] as? Object ?? [:]
            if route == "delete" { maps.removeValue(forKey: id) }
            else { map["revision"] = result["revision"]; maps[id] = map }
            state["maps"] = maps; pending.removeValue(forKey: id); state["pending"] = pending; try persist()
            return result
        } catch let error as APIError where error.status == 409 {
            var conflicts = state["conflicts"] as? Object ?? [:]; conflicts[id] = op
            state["conflicts"] = conflicts; pending.removeValue(forKey: id); state["pending"] = pending; try persist(); return nil
        }
    }
    func sync() async {
        guard running && !busy && !resolving else { return }; busy = true
        uploadsThisCycle = 0
        status = "正在同步…"
        defer { busy = false }
        do {
            guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { throw failure("日历权限已撤回，请重新授权") }
            let c = try refreshedCalendar()
            details = "正在读取：\(c.title ?? "DSH 日历助手") · \(c.source.title ?? "日历账户")"
            for id in Array((state["pending"] as? Object ?? [:]).keys) { _ = try await replay(id) }
            let response = try await request("state")
            guard response["schemaVersion"] as? Int == 1, let items = response["items"] as? [Object] else {
                throw failure("服务器状态格式不正确，未进行写入。")
            }
            var remote: [String: Object] = [:]; for i in items { if let id = i["id"] as? String { remote[id] = i } }
            var maps = state["maps"] as? Object ?? [:]
            let from = Calendar.current.date(byAdding: .year, value: -1, to: Date())!
            let to = Calendar.current.date(byAdding: .year, value: 5, to: Date())!
            var found: [EKEvent] = []; var cursor = from
            while cursor < to {
                let end = min(Calendar.current.date(byAdding: .year, value: 1, to: cursor)!, to)
                found += store.events(matching: store.predicateForEvents(withStart: cursor, end: end, calendars: [c]))
                cursor = end
            }
            var seen = Set<String>(); found = found.filter { seen.insert($0.eventIdentifier ?? UUID().uuidString).inserted }
            let unsupported = found.filter { $0.isAllDay || $0.hasRecurrenceRules }.count
            let orphaned = found.filter {
                $0.url?.scheme == "dshcalendar" && $0.url?.host == "item" && remote[String($0.url!.path.dropFirst())] == nil
            }.count
            let duplicateCalendars = store.calendars(for: .event).filter { $0.title == c.title && $0.calendarIdentifier != c.calendarIdentifier }.count
            let calendarLabel = "\(c.title ?? "DSH 日历助手") · \(c.source.title ?? "日历账户") · 标识末尾 \(c.calendarIdentifier.suffix(8))"
            details = "\(calendarLabel)\n扫描到 \(found.count) 项；全天/重复 \(unsupported) 项；服务器现有 \(items.filter { $0["deletedAt"] is NSNull }.count) 项。"
            // Recover identifiers after EventKit refresh or a crash between save and mapping persistence.
            for e in found where e.url?.scheme == "dshcalendar" && e.url?.host == "item" {
                let id = String(e.url!.path.dropFirst())
                if var map = maps[id] as? Object { map["eventId"] = e.eventIdentifier; maps[id] = map }
                else if let i = remote[id] { maps[id] = ["eventId": e.eventIdentifier ?? "", "revision": i["revision"] ?? 0, "snapshot": snapshot(e)] }
            }
            state["maps"] = maps; try persist()
            // Upload local edits against the revision last shown, never the newest server revision.
            for (id, rawMap) in maps {
                if (state["conflicts"] as? Object ?? [:])[id] != nil { continue }
                guard var map = rawMap as? Object, let i = remote[id] else { continue }
                if !(i["recurrence"] is NSNull) { continue }
                if let e = event(map, in: c) {
                    map["missing"] = 0
                    var current = state["maps"] as? Object ?? [:]; current[id] = map; state["maps"] = current
                    if e.hasRecurrenceRules || e.isAllDay { throw failure("专用日历只接收有明确时间的非重复事件；重复计划请在 QQ 中设置。") }
                    let local = snapshot(e)
                    if !same(local, map["snapshot"] as? Object ?? [:]) {
                        var edited: Object = [:]
                        for k in ["title","kind","notes","dueAt","durationMinutes","timeZone","recurrence","enabled","status"] { edited[k] = i[k] }
                        for (k,v) in local { edited[k] = v }
                        if var title = edited["title"] as? String {
                            if title.hasPrefix("✓ ") || title.hasPrefix("⏸ ") { title = String(title.dropFirst(2)) }; edited["title"] = title
                        }
                        map["snapshot"] = local; map["missing"] = 0
                        if let updated = try await write(id, route: "upsert", body: ["id": id, "baseRevision": map["revision"] ?? 0, "operationId": UUID().uuidString, "item": edited], map: map) { remote[id] = updated }
                    }
                } else {
                    if !(i["deletedAt"] is NSNull) { continue }
                    // Require two polls and a known date within the fully fetched window.
                    let d = try date((map["snapshot"] as? Object)?["dueAt"])
                    if d < from || d >= to { continue }
                    let misses = (map["missing"] as? Int ?? 0) + 1; map["missing"] = misses
                    var current = state["maps"] as? Object ?? [:]; current[id] = map; state["maps"] = current; try persist()
                    if misses >= 2, let updated = try await write(id, route: "delete", body: ["id": id, "baseRevision": map["revision"] ?? 0, "operationId": UUID().uuidString], map: map) { remote[id] = updated }
                }
            }
            try persist()
            // New Mac events only come from our dedicated calendar and contain no recurrence.
            let known = Set((state["maps"] as? Object ?? [:]).values.compactMap { ($0 as? Object)?["eventId"] as? String })
            for e in found where e.url?.scheme != "dshcalendar" && !known.contains(e.eventIdentifier ?? "") {
                guard !e.hasRecurrenceRules && !e.isAllDay else { continue }
                let id = UUID().uuidString; var item = snapshot(e)
                item["kind"] = "todo"; item["status"] = "open"; item["enabled"] = true; item["recurrence"] = NSNull()
                let map: Object = ["eventId": e.eventIdentifier ?? "", "snapshot": snapshot(e)]
                if let updated = try await write(id, route: "upsert", body: ["id": id, "baseRevision": 0, "operationId": UUID().uuidString, "item": item], map: map) { remote[id] = updated }
            }
            // Pull ordinary items. Missing local events awaiting deletion confirmation stay missing.
            maps = state["maps"] as? Object ?? [:]
            for (id, item) in remote {
                if (state["conflicts"] as? Object ?? [:])[id] != nil { continue }
                let map = maps[id] as? Object
                if !(item["deletedAt"] is NSNull) || !(item["recurrence"] is NSNull) {
                    if let map = map, let e = event(map, in: c) { try store.remove(e, span: .thisEvent, commit: true) }
                    maps.removeValue(forKey: id); continue
                }
                if let map = map, (map["missing"] as? Int ?? 0) > 0 { continue }
                let e = map.flatMap { event($0, in: c) } ?? EKEvent(eventStore: store); e.calendar = c
                try fill(e, from: item, id: id); try store.save(e, span: .thisEvent, commit: true)
                maps[id] = ["eventId": e.eventIdentifier ?? "", "revision": item["revision"] ?? 0, "snapshot": snapshot(e), "missing": 0]
                state["maps"] = maps; try persist()
            }
            state["maps"] = maps; try persist()
            let projections = try await request("projections")
            var projectionMaps = state["projections"] as? Object ?? [:]; var present = Set<String>()
            for item in projections["events"] as? [Object] ?? [] {
                guard let id = item["key"] as? String else { continue }; present.insert(id)
                let recovered = found.first { $0.url?.scheme == "dshcalendar" && $0.url?.host == "occurrence" && String($0.url!.path.dropFirst()) == id }
                let e = (projectionMaps[id] as? Object).flatMap { event($0, in: c) } ?? recovered ?? EKEvent(eventStore: store); e.calendar = c
                try fill(e, from: item, id: id, projected: true); try store.save(e, span: .thisEvent, commit: true)
                projectionMaps[id] = ["eventId": e.eventIdentifier ?? ""]; state["projections"] = projectionMaps; try persist()
            }
            for (id, raw) in projectionMaps where !present.contains(id) {
                if let map = raw as? Object, let e = event(map, in: c) { try store.remove(e, span: .thisEvent, commit: true) }
                projectionMaps.removeValue(forKey: id)
            }
            state["projections"] = projectionMaps; try persist()
            conflictCount = (state["conflicts"] as? Object ?? [:]).count
            details += "\n本轮成功上传 \(uploadsThisCycle) 次。"
            if found.isEmpty { details += "\n当前绑定的日历没有读到事件；请核对事件所在日历和账户。" }
            if duplicateCalendars > 0 { details += "\n另有 \(duplicateCalendars) 本同名日历，程序仅同步已绑定的这一本。" }
            if orphaned > 0 { details += "\n\(orphaned) 项带有旧同步标记，但服务器没有对应记录，已保留待排查。" }
            status = "最近同步：\(Date().formatted(date: .omitted, time: .standard))；每 10 秒同步。" + (conflictCount > 0 ? " \(conflictCount) 项冲突已保留，等待处理。" : "")
        } catch { status = "同步未完成，将重试：" + describe(error) }
    }
    func resolveConflicts() async {
        guard !busy && !resolving, calendar != nil else { return }; resolving = true
        defer { resolving = false }
        do {
            let c = try refreshedCalendar()
            // Save local versions in an unmanaged calendar before adopting server versions.
            let conflicts = state["conflicts"] as? Object ?? [:]
            let backup: EKCalendar
            if let id = state["conflictCalendar"] as? String, let existing = store.calendar(withIdentifier: id) { backup = existing }
            else {
                backup = EKCalendar(for: .event, eventStore: store); backup.title = "DSH 同步冲突副本"; backup.source = c.source
                try store.saveCalendar(backup, commit: true); state["conflictCalendar"] = backup.calendarIdentifier
            }
            var maps = state["maps"] as? Object ?? [:]
            for (id, raw) in conflicts {
                guard let op = raw as? Object, let map = op["map"] as? Object else { continue }
                if let local = event(map, in: c) {
                    let copy = EKEvent(eventStore: store); copy.calendar = backup; copy.title = local.title; copy.notes = local.notes
                    copy.startDate = local.startDate; copy.endDate = local.endDate; copy.timeZone = local.timeZone
                    try store.save(copy, span: .thisEvent, commit: true)
                    var m = map; m["snapshot"] = snapshot(local); m["missing"] = 0; maps[id] = m
                } else { maps.removeValue(forKey: id) }
            }
            state["maps"] = maps; state["conflicts"] = Object(); try persist(); conflictCount = 0
            status = "本地版本已保存到冲突副本日历。下次同步采用服务器版本。"
        } catch { status = describe(error) }
    }
}
@main struct CalendarSyncApp: App {
    @StateObject private var model = SyncModel()
    var body: some Scene {
        WindowGroup("DSH 日历同步") {
            VStack(alignment: .leading, spacing: 16) {
                Text("QQ 待办，与 Mac 日历同步").font(.title2).bold()
                Text("同步专用的「DSH 日历助手」。普通待办双向同步；习惯由 QQ 管理，在日历中展示。关闭程序或 Mac 休眠时暂停同步。")
                    .fixedSize(horizontal: false, vertical: true)
                TextField("服务器地址", text: $model.endpoint).disabled(model.running || model.busy || model.starting)
                SecureField("配对令牌（保存到钥匙串）", text: $model.token).disabled(model.running || model.busy || model.starting)
                HStack {
                    Button(model.running ? "暂停同步" : "授权并开启同步") { if model.running { model.stop() } else { Task { await model.start() } } }.disabled(model.busy || model.starting)
                    Button("立即同步") { Task { await model.sync() } }.disabled(!model.running || model.busy)
                }
                Text(model.status).textSelection(.enabled).font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                Text(model.details).textSelection(.enabled).font(.caption)
                    .fixedSize(horizontal: false, vertical: true)
                if model.conflictCount > 0 {
                    Button("保留本地副本，并采用服务器版本") { Task { await model.resolveConflicts() } }.disabled(model.busy || model.starting)
                }
                Text("0.1.2 · 每 10 秒同步一次；QQ 到点提醒及 30 秒催促由服务器持续运行。请勿在专用日历中创建全天或重复事件。")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }.padding(24).frame(width: 530)
        }.windowResizability(.contentSize)
    }
}
