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

    var body: some View {
        Form {
            Section {
                TextField("http://192.168.1.100:8092", text: $url)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                TextField("令牌", text: $token)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.system(.body, design: .monospaced))
            } header: {
                Text("连接信息")
            } footer: {
                Text("在电脑上双击 Sigma 客户端，窗口里会打印「地址」和「令牌」。两台设备要在同一个 Wi-Fi 下。")
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
                .disabled(busy || url.isEmpty || token.isEmpty)

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
                    LabeledContent("地址", value: link.baseURL)
                    LabeledContent("在线", value: link.online == true ? "是" : (link.online == false ? "否" : "未探测"))
                    Button("重新探测") { Task { await link.probe() } }
                }
                if link.online == true {
                    Section("预览") {
                        PCScreenView(baseURL: link.baseURL, token: link.token)
                            .aspectRatio(16.0 / 9.0, contentMode: .fit)
                    }
                }
            }
        }
        .navigationTitle("远程电脑")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            url = link.baseURL
            await link.probe()
        }
    }

    private func connect() async {
        busy = true
        message = nil
        link.connect(baseURL: url, token: token)
        await link.probe()
        busy = false
        message = link.online == true
            ? "连上了，对话页顶部会出现电脑屏幕。"
            : "连不上：确认客户端开着、两台设备在同一 Wi-Fi、Windows 防火墙允许了「专用网络」。"
    }
}
