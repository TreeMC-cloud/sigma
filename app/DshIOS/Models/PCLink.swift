import Foundation
import Observation
import Security

/// 和 Windows 客户端的连接配置。
///
/// 令牌存 Keychain 而不是 UserDefaults：
/// UserDefaults 是明文 plist，备份或导出文件一眼就能看到。
@MainActor
@Observable
final class PCLink {
    static let shared = PCLink()

    private enum Keys {
        static let url = "sigma.pc.url"
        static let token = "sigma.pc.token"
        static let code = "sigma.pc.code"
        static let relay = "sigma.pc.relay"
    }

    /// 内置中继。跨网络时 App 直接访问 `/c/<配对码>`，不需要自己实现隧道。
    static let defaultRelay = "http://202.189.51.44:8791"

    /// 形如 `http://192.168.1.100:8092`；跨网模式下是中继地址
    private(set) var baseURL: String = ""
    /// 跨网配对码；非空表示走中继
    private(set) var pairCode: String = ""
    private(set) var relayBase: String = defaultRelay
    private(set) var hasToken = false
    /// 最近一次探测结果，界面上用来显示「在线/离线」
    private(set) var online: Bool?

    private init() {
        baseURL = UserDefaults.standard.string(forKey: Keys.url) ?? ""
        pairCode = UserDefaults.standard.string(forKey: Keys.code) ?? ""
        relayBase = UserDefaults.standard.string(forKey: Keys.relay) ?? Self.defaultRelay
        hasToken = Keychain.get(Keys.token) != nil
    }

    /// 只走局域网
    var isDirect: Bool { !baseURL.isEmpty && pairCode.isEmpty }

    /// 走中继
    var isRelay: Bool { !pairCode.isEmpty }

    var isConfigured: Bool { (isDirect || isRelay) && hasToken }

    /// 真正用来发请求的前缀。
    /// 跨网时拼成 `http://中继:8791/c/配对码` —— 中继会把这段当成
    /// 「转给那台电脑」的标记，其余路径原样透传。
    var effectiveBase: String {
        if isRelay { return relayBase + "/c/" + pairCode }
        return baseURL
    }

    /// 给小窗用的令牌（用到时才从 Keychain 取，不常驻内存）
    var token: String { Keychain.get(Keys.token) ?? "" }

    /// 直连（同一 Wi-Fi）
    func connect(baseURL raw: String, token: String) {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        baseURL = trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
        pairCode = ""
        UserDefaults.standard.set(baseURL, forKey: Keys.url)
        UserDefaults.standard.removeObject(forKey: Keys.code)
        Keychain.set(token, for: Keys.token)
        hasToken = !token.isEmpty
        online = nil
    }

    /// 跨网络：只填 6 位配对码。中继地址可留空（用内置的）。
    func connect(pairCode raw: String, token: String, relay: String = "") {
        let code = raw.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        pairCode = code
        let r = relay.trimmingCharacters(in: .whitespacesAndNewlines)
        relayBase = r.isEmpty ? Self.defaultRelay : (r.hasSuffix("/") ? String(r.dropLast()) : r)
        baseURL = ""
        UserDefaults.standard.set(code, forKey: Keys.code)
        UserDefaults.standard.set(relayBase, forKey: Keys.relay)
        UserDefaults.standard.removeObject(forKey: Keys.url)
        Keychain.set(token, for: Keys.token)
        hasToken = !token.isEmpty
        online = nil
    }

    func disconnect() {
        baseURL = ""
        pairCode = ""
        UserDefaults.standard.removeObject(forKey: Keys.url)
        UserDefaults.standard.removeObject(forKey: Keys.code)
        Keychain.delete(Keys.token)
        hasToken = false
        online = nil
    }

    /// 探活：`GET /health` 不需要令牌，用来区分「地址错」和「令牌错」。
    func probe() async {
        guard isConfigured, let url = URL(string: effectiveBase + "/health") else {
            online = nil
            return
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 5
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            online = (resp as? HTTPURLResponse)?.statusCode == 200
        } catch {
            online = false
        }
    }
}

/// 极简 Keychain 封装：只存一个字符串。
///
/// 不为存一个 token 引入第三方库——Security 框架四个函数就够。
private enum Keychain {
    static func set(_ value: String, for key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = Data(value.utf8)
        // 只在本机、解锁后可读；不参与 iCloud 同步
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    static func get(_ key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
