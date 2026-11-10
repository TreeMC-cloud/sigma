import SwiftUI
import UIKit

/// 电脑屏幕小窗：拉 MJPEG 流，逐帧解成 UIImage 显示。
///
/// 为什么不用 AsyncImage：它是「请求一次拿一张图」，不支持
/// `multipart/x-mixed-replace` 的持续流。这里的流是一条永不结束的
/// HTTP 响应，每帧之间用边界分隔，必须自己按字节切。
///
/// 为什么不用 AVPlayer：MJPEG 不是视频容器格式，AVFoundation 不认。
///
/// 关键约束：**只在可见时拉流**。手机和电脑都在局域网，一直推流会同时
/// 烧两边电量；`onDisappear` 里必须 stop，否则退出页面后还在后台收数据。
struct PCScreenView: View {
    let baseURL: String
    let token: String

    @State private var frame: UIImage?
    @State private var status: Status = .idle
    @State private var fps: Double = 0
    @State private var receiver: MJPEGReceiver?

    enum Status: Equatable {
        case idle, connecting, live, failed(String)
    }

    var body: some View {
        ZStack {
            Color.black
            if let frame {
                Image(uiImage: frame)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
            } else {
                placeholder
            }
            // 右上角状态：让人知道「是在连」「在播」还是「挂了」
            VStack {
                HStack {
                    Spacer()
                    badge
                }
                Spacer()
            }
            .padding(6)
        }
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Color.white.opacity(0.12), lineWidth: 1)
        )
        .onAppear(perform: start)
        .onDisappear(perform: stop)
    }

    private var placeholder: some View {
        VStack(spacing: 8) {
            Image(systemName: status.icon)
                .font(.system(size: 22, weight: .light))
                .foregroundStyle(.white.opacity(0.5))
            Text(status.text)
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.45))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 12)
        }
    }

    private var badge: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(status == .live ? Color.green : Color.orange)
                .frame(width: 6, height: 6)
            if status == .live, fps > 0 {
                Text(String(format: "%.0f fps", fps))
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.75))
            }
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(.black.opacity(0.45), in: Capsule())
    }

    private func start() {
        guard receiver == nil else { return }
        guard let url = URL(string: baseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/screen") else {
            status = .failed("地址不对")
            return
        }
        status = .connecting
        let r = MJPEGReceiver(url: url, token: token)
        r.onFrame = { image in
            // 主线程更新 UI；fps 用简单滑动平均，避免数字乱跳
            DispatchQueue.main.async {
                frame = image
                status = .live
                fps = fps == 0 ? r.currentFPS : fps * 0.8 + r.currentFPS * 0.2
            }
        }
        r.onError = { message in
            DispatchQueue.main.async {
                status = .failed(message)
                frame = nil
            }
        }
        r.start()
        receiver = r
    }

    private func stop() {
        receiver?.stop()
        receiver = nil
        frame = nil
        status = .idle
        fps = 0
    }
}

private extension PCScreenView.Status {
    var text: String {
        switch self {
        case .idle: return "未连接"
        case .connecting: return "连接中…"
        case .live: return ""
        case .failed(let m): return m
        }
    }
    var icon: String {
        switch self {
        case .idle, .connecting: return "display"
        case .live: return "display"
        case .failed: return "exclamationmark.triangle"
        }
    }
}

/// MJPEG 接收器：按 `multipart/x-mixed-replace` 的边界切帧。
///
/// 边界取值不假设是 `--frame`：服务端可能带引号、可能用别的 token，
/// 所以先从响应头 `boundary=` 里读出来，读不到才退回默认值。
final class MJPEGReceiver: NSObject, URLSessionDataDelegate {
    private let url: URL
    private let token: String
    private var session: URLSession!
    private var task: URLSessionDataTask?

    private var boundary: Data = Data("--frame".utf8)
    private var buffer = Data()
    private var framesThisSecond = 0
    private var lastTick = Date()
    private(set) var currentFPS: Double = 0

    var onFrame: ((UIImage) -> Void)?
    var onError: ((String) -> Void)?
    private var stopped = false

    init(url: URL, token: String) {
        self.url = url
        self.token = token
        super.init()
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 15
        // 流是长连接，别让系统因为「没有新字节」而超时掐断
        cfg.timeoutIntervalForResource = .greatestFiniteMagnitude
        session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }

    func start() {
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        task = session.dataTask(with: req)
        task?.resume()
    }

    func stop() {
        stopped = true
        task?.cancel()
        session.invalidateAndCancel()
    }

    // MARK: URLSessionDataDelegate

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if let http = response as? HTTPURLResponse {
            let ct = http.value(forHTTPHeaderField: "Content-Type") ?? "(无)"
            screenLog("响应 \(http.statusCode) · \(ct)")
            if http.statusCode == 401 { onError?("令牌不对"); completionHandler(.cancel); return }
            if http.statusCode != 200 { onError?("电脑返回 \(http.statusCode)"); completionHandler(.cancel); return }
            if let ct = http.value(forHTTPHeaderField: "Content-Type"),
               let range = ct.range(of: "boundary=") {
                let b = ct[range.upperBound...].trimmingCharacters(in: CharacterSet(charactersIn: "\"; "))
                if !b.isEmpty { boundary = Data(("--" + b).utf8) }
            }
        }
        completionHandler(.allow)
    }

    /// 写一行诊断日志。
    ///
    /// 不能调 `Diagnostics.shared.record`：那是 MainActor 隔离的，
    /// 而 URLSession 的回调在后台线程，编译期会报
    /// 「call to main actor-isolated instance method in a synchronous nonisolated context」。
    /// 这里直接走 nonisolated 的 appendLine，线程安全且顺序正确。
    private func screenLog(_ text: String) {
        let url = EnginePaths.real(EnginePaths.shared + "/app.log")
        let stamp = ISO8601DateFormatter().string(from: Date())
        Diagnostics.appendLine("[\(stamp)] 屏幕 · \(text)", to: url)
    }

    private var dataBatches = 0

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        buffer.append(data)
        dataBatches += 1
        if dataBatches <= 5 {
            screenLog("第 \(dataBatches) 批 \(data.count) 字节，缓冲 \(buffer.count)")
        }
        extractFrames()
        if dataBatches == 1, buffer.count > 0 {
            // 第一批的首字节很关键：能看出服务端到底发了什么格式
            let head = buffer.prefix(40).map { String(format: "%02x", $0) }.joined()
            screenLog("首字节 \(head)")
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard !stopped else { return }
        if let error {
            let ns = error as NSError
            if ns.code == NSURLErrorCancelled { return }
            screenLog("失败 \(ns.code) · \(ns.localizedDescription)")
            onError?("连接中断（\(ns.code)）")
        } else {
            onError?("电脑断开了连接")
        }
    }

    /// 从 buffer 里切出完整帧。
    ///
    /// **不依赖 multipart 边界**。实测客户端发来的是
    /// `605c\r\n<JPEG bytes>605c\r\n<JPEG bytes>...`
    /// —— 长度用的是十六进制文本 + CRLF，而不是标准的 `--boundary` 分隔。
    /// 按 boundary 切永远切不出来，界面就永远停在「连接中」。
    ///
    /// JPEG 的结构是确定的：`FF D8` 开头，`FF D9` 结尾。按这个切最稳，
    /// 也不怕将来服务端换分帧方式。
    private static let soi = Data([0xFF, 0xD8])
    private static let eoi = Data([0xFF, 0xD9])

    private func extractFrames() {
        while true {
            // 1) 找到帧起点
            guard let start = buffer.range(of: Self.soi) else {
                // 没有起点：保留最后 1 字节（0xFF 可能被切开）
                if buffer.count > 1 { buffer = buffer.suffix(1) }
                return
            }
            if start.lowerBound > buffer.startIndex {
                buffer.removeSubrange(buffer.startIndex..<start.lowerBound)
            }
            // 2) 从起点之后找帧终点 FFD9
            let afterSoi = buffer.index(buffer.startIndex, offsetBy: 2)
            guard let end = buffer.range(of: Self.eoi, in: afterSoi..<buffer.endIndex) else {
                // 还没收完。但要防止垃圾数据无限增长
                if buffer.count > 4 * 1024 * 1024 { buffer.removeAll() }
                return
            }
            let jpeg = buffer.subdata(in: buffer.startIndex..<end.upperBound)
            buffer.removeSubrange(buffer.startIndex..<end.upperBound)

            if jpeg.count > 100, let img = UIImage(data: jpeg) {
                tick()
                onFrame?(img)
            }
        }
    }

    private func tick() {
        framesThisSecond += 1
        let now = Date()
        let dt = now.timeIntervalSince(lastTick)
        if dt >= 1 {
            currentFPS = Double(framesThisSecond) / dt
            framesThisSecond = 0
            lastTick = now
        }
    }
}

/// 对话页顶部的可折叠小窗。
///
/// 三个状态：
///   · 未连接 → 整块不出现（不占空间，不打扰）
///   · 已连接但收起 → 一条细栏，点一下展开
///   · 展开 → 16:9 的画面 + 收起按钮
///
/// 为什么不自动展开：用户可能只想聊天，不想每进一个会话就顶着一块视频。
@MainActor
struct PCScreenDock: View {
    @Environment(PCLink.self) private var link
    @State private var expanded = true
    @State private var dismissed = false

    var body: some View {
        Group {
            if link.isConfigured, !dismissed {
                VStack(spacing: 0) {
                    header
                    if expanded {
                        PCScreenView(baseURL: link.effectiveBase, token: link.token)
                            .aspectRatio(16.0 / 9.0, contentMode: .fit)
                            .padding(.horizontal, 10)
                            .padding(.bottom, 8)
                    }
                }
                .background(.ultraThinMaterial)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.snappy(duration: 0.22), value: expanded)
        .task { await link.probe() }
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "display")
                .font(.caption)
                .foregroundStyle(Palette.secondary)
            Text(link.online == true ? "电脑屏幕" : "电脑离线")
                .font(.caption.weight(.medium))
                .foregroundStyle(link.online == true ? Palette.ink : Palette.secondary)
            if link.online == true {
                Circle().fill(Palette.running).frame(width: 5, height: 5)
            }
            Spacer()
            Button {
                expanded.toggle()
            } label: {
                Image(systemName: expanded ? "chevron.up" : "chevron.down")
                    .font(.caption2)
                    .foregroundStyle(Palette.secondary)
            }
            Button {
                dismissed = true
            } label: {
                Image(systemName: "xmark")
                    .font(.caption2)
                    .foregroundStyle(Palette.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
    }
}
