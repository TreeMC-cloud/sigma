import SwiftUI

/// 读日志的固定参数。放在文件级而不是视图里：
/// 后台读取的任务不该为了一个常量去碰视图类型。
private enum LogTail {
    /// 只渲染最后这么多行：日志涨到几 MB 时，把全文塞进一个 Text
    /// 会让首屏卡上好几秒，而真正要看的几乎总在末尾。
    static let lines = 2000
    static let bottomId = "engine-log-bottom"
}

/// 设置 → 高级 → 引擎日志。
///
/// 引擎把 stdout/stderr 都写进 `engine.log`，出问题时人要找的是里面某几行，
/// 而不是从几 MB 文本的开头往下翻。这一页因此只取文件尾部，并在 App 侧做
/// 级别、关键词、只看错误三种筛选——引擎完全不用知道有这回事。
struct EngineLogView: View {
    let file: URL

    private static let bottomId = LogTail.bottomId

    @State private var snapshot = LogSnapshot()
    @State private var query = ""
    @State private var onlyProblems = false
    @State private var loading = true
    /// 用户是否还停在最后一行：「跳到最新」只在翻走之后浮出来，
    /// 否则它会一直压着最新那条日志。
    @State private var atBottom = true
    /// 每加一次就滚到底一次。为什么不把 proxy 直接传进 load：
    /// `.task`/`.refreshable` 的闭包是 @Sendable，proxy 不是，能编译但会留警告；
    /// 用计数器把「读完了」和「滚到底」解耦，两边都不用跨隔离传视图对象。
    @State private var scrollToken = 0

    private var needle: String { query.trimmed }

    var body: some View {
        // 筛选结果只算一次往下传：`shown` 要扫两千行，
        // 在顶部说明、列表、按钮里各算一遍就是一次渲染扫三遍。
        let rows = shown
        ScrollViewReader { proxy in
            VStack(spacing: 0) {
                controlBar(rows)
                logScroll(rows)
            }
            .background(Palette.background)
            .overlay(alignment: .bottomTrailing) { jumpButton(proxy, rows) }
            .navigationTitle("引擎日志")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                        .accessibilityLabel("刷新")
                    ShareLink(item: file)
                }
            }
            .task { await load() }
            .onChange(of: scrollToken) { _, _ in scrollToLatest(proxy) }
        }
    }

    // MARK: 顶部

    /// 固定在滚动区外面：日志很长，筛选条件和「只显示最后 N 行」的说明
    /// 必须一直看得见，不能跟着内容滚走。
    private func controlBar(_ rows: [LogLine]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                searchField
                Toggle("只看错误", isOn: $onlyProblems)
                    .toggleStyle(.button)
                    .tint(Palette.ink)
                    .font(.footnote)
                    .accessibilityHint("只显示包含 error 或 warn 的行")
            }
            Text(summary(rows))
                .font(.caption2)
                .foregroundStyle(Palette.secondary)
                .lineLimit(2)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Palette.background)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Palette.stroke).frame(height: 0.5)
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(Palette.faint)
            TextField("搜索日志", text: $query)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Palette.faint)
                        .contentShape(Rectangle().inset(by: -8))
                }
                .accessibilityLabel("清空搜索")
            }
        }
        .font(.subheadline)
        .padding(.horizontal, 12)
        .frame(minHeight: 36)
        .background(Palette.bubble, in: Capsule())
    }

    /// 顶部那行说明。为什么不写「共 N 行」：尾部之外的内容根本没读进来，
    /// 要给出精确总数就得整份读一遍（几 MB），不如只说清楚「看到的是最后多少行」。
    private func summary(_ rows: [LogLine]) -> String {
        if snapshot.error != nil { return String(localized: "读不到日志文件") }
        guard !snapshot.lines.isEmpty else { return String(localized: "日志为空") }
        var parts: [String] = []
        if snapshot.truncated {
            parts.append(String(localized: "只显示最后 \(snapshot.lines.count) 行，完整日志 \(sizeText)"))
        } else {
            parts.append(String(localized: "共 \(snapshot.lines.count) 行，\(sizeText)"))
        }
        if !needle.isEmpty || onlyProblems {
            parts.append(String(localized: "筛选后 \(rows.count) 行"))
        }
        return parts.joined(separator: " · ")
    }

    private var sizeText: String {
        ByteCountFormatter.string(fromByteCount: Int64(snapshot.bytes), countStyle: .file)
    }

    // MARK: 列表

    /// 当前要显示的行。筛选全在内存里做：两千行足够快，
    /// 而重新读文件会打乱用户已经找到的位置。
    private var shown: [LogLine] {
        var rows = snapshot.lines
        if onlyProblems { rows = rows.filter { $0.level != .normal } }
        guard !needle.isEmpty else { return rows }
        return rows.filter { $0.text.range(of: needle, options: .caseInsensitive) != nil }
    }

    private func logScroll(_ rows: [LogLine]) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let error = snapshot.error {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(Palette.removed)
                        .padding(16)
                } else if rows.isEmpty {
                    if !loading { emptyState.padding(.top, 60) }
                } else {
                    ForEach(rows) { line in
                        LogRow(line: line, needle: needle)
                    }
                }
                Color.clear.frame(height: 1).id(Self.bottomId)
                    // 底部标记在视口内就等于「用户还停在最新一行」。
                    // 不用滚动几何：部署目标是 iOS 17，那里没有 scroll geometry；
                    // 而 LazyVStack 只为视口附近的行回调 onAppear/onDisappear，够用了。
                    .onAppear { atBottom = true }
                    .onDisappear { atBottom = false }
            }
            .padding(.vertical, 8)
        }
        // 打开就停在最新一行：出问题时人要看的是刚发生的事。
        .defaultScrollAnchor(.bottom)
        .refreshable { await load() }
        // 换关键词或开关筛选后同样回到最新一条：这一页的心智是「从末尾往回找」，
        // 留在原来那个偏移上只会看到一段和筛选无关的上下文。
        .onChange(of: needle) { _, _ in scrollToken += 1 }
        .onChange(of: onlyProblems) { _, _ in scrollToken += 1 }
    }

    @ViewBuilder
    private var emptyState: some View {
        if !needle.isEmpty {
            ContentUnavailableView.search(text: needle)
        } else if onlyProblems {
            ContentUnavailableView(
                "没有错误或警告",
                systemImage: "checkmark.circle",
                description: Text("这次的引擎输出里没有 error 或 warn。")
            )
        } else {
            ContentUnavailableView(
                "日志为空",
                systemImage: "doc.text",
                description: Text("引擎启动后会把输出写进 engine.log。")
            )
        }
    }

    @ViewBuilder
    private func jumpButton(_ proxy: ScrollViewProxy, _ rows: [LogLine]) -> some View {
        if !atBottom && !rows.isEmpty {
            Button {
                Haptics.tap()
                withAnimation(.snappy(duration: 0.2)) { proxy.scrollTo(Self.bottomId, anchor: .bottom) }
            } label: {
                Label("跳到最新", systemImage: "arrow.down.to.line")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Palette.ink)
                    .padding(.horizontal, 14)
                    .frame(height: 38)
                    .background(Palette.background, in: Capsule())
                    .overlay { Capsule().strokeBorder(Palette.stroke) }
            }
            .padding(.trailing, 16)
            .padding(.bottom, 16)
            .transition(.opacity.combined(with: .scale(scale: 0.9)))
        }
    }

    // MARK: 读取

    private func load() async {
        // 只在第一次读时显示转圈：刷新时留着旧内容，
        // 否则每次下拉都闪一下空白，反而看不出日志有没有变。
        if snapshot.lines.isEmpty { loading = true }
        let url = file
        let value = await Task.detached(priority: .userInitiated) {
            LogSnapshot.read(url, limit: LogTail.lines)
        }.value
        snapshot = value
        loading = false
        atBottom = true
        scrollToken += 1
    }

    /// 下一帧再滚：刚换过内容时行还没有高度，这时 scrollTo 会落到旧的位置上。
    /// 和 ConversationView 回到底部的写法一致。
    private func scrollToLatest(_ proxy: ScrollViewProxy) {
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(60))
            proxy.scrollTo(Self.bottomId, anchor: .bottom)
        }
    }
}

/// 一行日志。级别在构造时算一次，不放在 body 里——
/// 否则每次重绘都要把两千行重新 lowercased 一遍。
private struct LogLine: Identifiable, Sendable {
    enum Level: Sendable { case error, warning, normal }

    let id: Int
    let text: String
    let level: Level

    init(index: Int, text: String) {
        self.id = index
        self.text = text
        let lower = text.lowercased()
        // 先判 error：一行同时带 error 和 warn 时按更严重的算，
        // 免得一条真正的失败被自己的上下文淹成黄色。
        if lower.contains("error") {
            level = .error
        } else if lower.contains("warn") {
            level = .warning
        } else {
            level = .normal
        }
    }
}

/// 一行日志的视图。单独成 View 而不是在 ForEach 里现拼 Text：
/// LazyVStack 只为可见的行创建它，高亮用的 AttributedString 也才只算这几十行。
private struct LogRow: View {
    let line: LogLine
    let needle: String

    var body: some View {
        Text(attributed)
            .font(.caption2.monospaced())
            .foregroundStyle(tint)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 1)
    }

    private var tint: Color {
        switch line.level {
        case .error: Palette.removed
        case .warning: Palette.waiting
        case .normal: Palette.ink
        }
    }

    /// 关键词可能在原文里出现多次，按 String.Index 逐段拼接。
    /// 为什么不换算成 AttributedString 的下标：中文和 emoji 日志里任何一次
    /// 偏移算错都会直接越界崩溃，拼接则不会。
    private var attributed: AttributedString {
        guard !needle.isEmpty else { return AttributedString(line.text) }
        var result = AttributedString()
        var cursor = line.text.startIndex
        while let found = line.text.range(of: needle, options: .caseInsensitive, range: cursor..<line.text.endIndex) {
            result += AttributedString(String(line.text[cursor..<found.lowerBound]))
            var hit = AttributedString(String(line.text[found]))
            // 用墨色的低透明度做底色，而不是某个固定色：
            // 浅色/深色两套主题下都能压住，也不和 error/warn 的语义色抢意思。
            hit.backgroundColor = Palette.ink.opacity(0.16)
            result += hit
            cursor = found.upperBound
        }
        result += AttributedString(String(line.text[cursor...]))
        return result
    }
}

/// 一次读取的结果。行、级别和文件大小一起在后台算好再交给主线程。
private struct LogSnapshot: Sendable {
    var lines: [LogLine] = []
    var bytes = 0
    /// 文件比读进来的部分更长，顶部要说明「只显示最后 N 行」。
    var truncated = false
    var error: String?

    /// 从文件尾部往回读。为什么按窗口翻倍而不是整份读：
    /// engine.log 可以有几 MB，全读进来再切行，打开这一页要白等一秒以上；
    /// 而从 256 KB 起翻倍，常见情况下第一次就够了。
    static func read(_ url: URL, limit: Int) -> LogSnapshot {
        guard let handle = try? FileHandle(forReadingFrom: url) else {
            return LogSnapshot(error: String(localized: "打不开日志文件"))
        }
        defer { try? handle.close() }
        guard let size = try? handle.seekToEnd() else {
            return LogSnapshot(error: String(localized: "读不到日志文件"))
        }
        var snapshot = LogSnapshot()
        snapshot.bytes = Int(min(size, UInt64(Int.max)))
        var window = 256 * 1024
        while true {
            let start = size > UInt64(window) ? size - UInt64(window) : 0
            _ = try? handle.seek(toOffset: start)
            var lines = String(decoding: handle.readDataToEndOfFile(), as: UTF8.self)
                .components(separatedBy: "\n")
            // 窗口从文件中间切进来时第一行只有半截，丢掉——
            // 半条日志比没有更误导人。
            if start > 0 && !lines.isEmpty { lines.removeFirst() }
            // 文件末尾的换行会切出一个空串，那不是真的一行。
            while lines.last == "" { lines.removeLast() }
            let enough = lines.count > limit || start == 0 || window >= 8 * 1024 * 1024
            if enough {
                snapshot.truncated = start > 0 || lines.count > limit
                snapshot.lines = lines.suffix(limit).enumerated().map { LogLine(index: $0.offset, text: $0.element) }
                return snapshot
            }
            window *= 2
        }
    }
}
