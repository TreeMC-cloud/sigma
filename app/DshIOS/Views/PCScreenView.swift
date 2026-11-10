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
        // `@State` 是 MainActor 隔离的。闭包在后台线程跑，
        // 用 DispatchQueue.main.async 在 Swift 6 严格并发下仍会报
        // 「main actor-isolated property cannot be mutated from a Sendable closure」。
        // `Task { @MainActor in ... }` 是唯一能让编译器认的写法。
        r.onFrame = { [self] image in
            Task { @MainActor in
                self.frame = image
                self.status = .live
                self.fps = self.fps == 0 ? r.currentFPS : self.fps * 0.8 + r.currentFPS * 0.2
            }
        }
        r.onError = { [self] message in
            Task { @MainActor in
                self.status = .failed(message)
                self.frame = nil
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

/// 单帧轮询器。
///
/// **为什么放弃 MJPEG 长连接**：真机日志反复证明 —— 响应头回来了（200），
/// 但 `URLSessionDataDelegate.didReceive` 一次都没被调用，60 秒后 -1001。
/// curl 对同一个地址能收到 90 帧/10 秒，所以链路没问题，是「无限流 +
/// chunked」这条组合在 iOS 上走不通（URLSession 会一直缓冲等结束）。
///
/// 换成**每 250ms 拉一张 `/screen/one`**：
///   · 每个请求都有明确的 Content-Length，是普通的请求-响应
///   · URLSession 一定能处理，不依赖流式回调
///   · 代价是多一点开销（4 次/秒 vs 9fps），肉眼几乎看不出差别
/// 实测这个取舍比「一直连接中」好得多。
final class MJPEGReceiver: NSObject {
    private let url: URL
    private let token: String
    private var timer: Timer?
    private var inFlight = false
    private(set) var currentFPS: Double = 4

    var onFrame: ((UIImage) -> Void)?
    var onError: ((String) -> Void)?
    /// 写一行诊断日志。
    ///
    /// 不用 `Diagnostics.shared.record`：那是 MainActor 隔离的，而这里在后台线程。
    /// 不用 static：Swift 6 对可变 static 的严格并发检查会让编译失败。
    /// 改成实例方法 + 实例计数器，任何线程都能调，也没有并发标注的坑。
    private var reqCount = 0
    private var frameCount = 0

    private func log(_ text: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        let path = EnginePaths.real(EnginePaths.shared + "/app.log")
        Diagnostics.appendLine("[\(stamp)] 屏幕 · \(text)", to: path)
    }

    private var stopped = false

    init(url: URL, token: String) {
        // 基地址是 `.../c/<code>`，把最后的 /screen 换成 /screen/one
        let base = url.absoluteString.replacingOccurrences(of: "/screen", with: "/screen/one")
        self.url = URL(string: base) ?? url
        self.token = token
        super.init()
    }

    func start() {
        stop()
        stopped = false
        log("开始轮询 \(url.absoluteString)")
        // 立刻拉一次，别让用户等
        tick()
        let t = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    func stop() {
        stopped = true
        timer?.invalidate()
        timer = nil
    }

    private func tick() {
        guard !stopped, !inFlight else { return }
        inFlight = true
        reqCount += 1
        log("请求 #\(reqCount)")
        var req = URLRequest(url: url)
        req.timeoutInterval = 8
        // 单个请求短超时：一帧拿不到就跳过一次，绝不拖住整个循环
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        req.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData

        URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
            guard let self else { return }
            defer { self.inFlight = false }
            guard !self.stopped else { return }

            if let e = err {
                let ns = e as NSError
                if ns.code != NSURLErrorCancelled {
                    log("失败 \(ns.code)：\(ns.localizedDescription)")
                    self.onError?("第 \(ns.code) 号错误：\(ns.localizedDescription)")
                }
                return
            }
            guard let http = resp as? HTTPURLResponse else {
                log("不是 HTTP 响应")
                return
            }
            if http.statusCode == 401 {
                log("401 令牌不对")
                self.onError?("令牌不对")
                return
            }
            guard http.statusCode == 200 else {
                log("状态码 \(http.statusCode)")
                self.onError?("电脑返回 \(http.statusCode)")
                return
            }
            guard let data else {
                log("200 但无数据")
                return
            }
            guard let img = UIImage(data: data) else {
                let head = data.prefix(16).map { String(format: "%02x", $0) }.joined()
                log("解码失败 \(data.count) 字节，头 \(head)")
                return
            }

            frameCount += 1
            if frameCount <= 3 || frameCount % 40 == 0 {
                log("收到第 \(frameCount) 帧 \(data.count) 字节")
            }
            DispatchQueue.main.async {
                guard !self.stopped else { return }
                self.onFrame?(img)
            }
        }.resume()
    }
}

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
