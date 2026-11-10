import SwiftUI

/// 设置 → 远程电脑：填客户端窗口里打印的地址和令牌。
///
/// 刻意做得很笨：两个输入框 + 一个连接按钮。
/// 用户此刻手里拿着一张写着「地址 / 令牌」的窗口，越少字段越不容易填错。
struct RemotePCPage: View {
    @Environment(PCLink.self) private var link
    @State private var url = ""
    @State private var token = ""
    @State private var busy = false
    @State private var message: String?

    @State private var mode: Mode = .direct

    enum Mode: String, CaseIterable {
        case direct = "同一 Wi-Fi"
        case relay = "跨网络"
    }

    var body: some View {
        Form {
            Section {
                Picker("连接方式", selection: $mode) {
                    ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
            }

            if mode == .direct {
                Section {
                    TextField("http://192.168.1.100:8092", text: $url)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    tokenField
                } header: {
                    Text("局域网地址")
                } footer: {
                    Text("电脑和手机连同一个 Wi-Fi 时用这个。地址和令牌在客户端窗口里。")
                }
            } else {
                Section {
                    TextField("6 位配对码", text: $code)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.system(.title3, design: .monospaced))
                    tokenField
                } header: {
                    Text("配对码")
                } footer: {
                    Text("不在同一网络时用这个。配对码在客户端窗口「配对码」那一行，6 位字母数字。不需要设置路由器。")
                }
                Section {
                    TextField("中继地址（留空用内置）", text: $relay)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                } footer: {
                    Text("默认使用内置中继，一般不用改。")
                }
            }

            Section {
                Button {
                    Task { await connect() }
                } label: {
                    HStack {
                        if busy { ProgressView().controlSize(.small) }
                        Text(busy ? "连接中…" : "连接")
                    }
                }
                .disabled(busy || !canConnect)

                if link.isConfigured {
                    Button("断开", role: .destructive) {
                        link.disconnect()
                        message = nil
                    }
                }
            }

            if let message {
                Section { Text(message).font(.callout).foregroundStyle(.secondary) }
            }

            if link.isConfigured {
                Section("状态") {
                    LabeledContent("方式", value: link.isRelay ? "跨网络" : "同一 Wi-Fi")
                    LabeledContent("地址", value: link.isRelay
                        ? "\(link.relayBase)/c/\(link.pairCode)"
                        : link.baseURL)
                    LabeledContent("在线", value: link.online == true ? "是" : (link.online == false ? "否" : "未探测"))
                    Button("重新探测") { Task { await link.probe() } }
                }
                if link.online == true {
                    Section("预览") {
                        PCScreenView(baseURL: link.effectiveBase, token: link.token)
                            .aspectRatio(16.0 / 9.0, contentMode: .fit)
                    }
                }
            }
        }
        .navigationTitle("远程电脑")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            // 回填已有配置
            if link.isRelay {
                mode = .relay
                code = link.pairCode
                relay = ""
            } else {
                url = link.baseURL
            }
            await link.probe()
        }
    }

    private var tokenField: some View {
        TextField("令牌", text: $token)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .font(.system(.body, design: .monospaced))
    }

    private var canConnect: Bool {
        guard !token.isEmpty else { return false }
        return mode == .direct ? !url.isEmpty : code.count >= 4
    }

    private func connect() async {
        busy = true
        message = nil
        if mode == .direct {
            link.connect(baseURL: url, token: token)
        } else {
            link.connect(pairCode: code, token: token, relay: relay)
        }
        await link.probe()
        busy = false
        if link.online == true {
            message = mode == .direct
                ? "连上了，对话页顶部会出现电脑屏幕。"
                : "连上了（经中继）。对话页顶部会出现电脑屏幕。"
        } else {
            message = mode == .direct
                ? "连不上：确认客户端开着、两台设备在同一 Wi-Fi、Windows 防火墙允许了「专用网络」。"
                : "连不上：核对配对码；确认电脑上的客户端开着并且显示「中继 已上线」。"
        }
    }
}
