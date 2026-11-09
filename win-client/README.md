# Sigma Windows 客户端

给 Sigma（iPhone 上的 agent）连你 Windows 电脑用。**零依赖、单文件、不开公网端口。**

## 一、装

1. 装 Node.js（LTS 版）：https://nodejs.org/zh-cn
2. 把 `server.mjs` 和 `start.bat` 放进同一个文件夹（比如 `D:\Sigma`）
3. 双击 `start.bat`

黑窗口会打印：

```
  地址    http://192.168.1.100:8092
  配对码  VONSGF
  令牌    voNsGFQwq-FL33vfOOv1KdeEsJZvQJ06
```

第一次运行会生成 `config.json`，令牌存在里面，以后不变。

## 二、连

手机 Sigma → 设置 → **远程电脑** → 填上面那个 `地址` + `令牌`。

同一个 Wi-Fi 下直接就连上了。

## 三、跨网络（不同 Wi-Fi）

不要开公网端口。装 **Tailscale**（免费，100 台设备）：

1. Windows 装 Tailscale，登录
2. iPhone 也装 Tailscale，登录同一个账号
3. Windows 上会多一个 `100.x.y.z` 地址
4. 手机端填 `http://100.x.y.z:8092`

这样两台设备就像在同一局域网，**数据不经过我们的服务器**。

## 四、能给 agent 做什么

默认只开放**只读**能力：

| 能力 | 说明 |
|---|---|
| `info` | 系统信息、CPU、内存、网卡地址 |
| `list` | 列目录 |
| `read` | 读文件（超 256KB 会截断） |
| `write` | 写文件 |

**命令执行默认关闭。** 要开就编辑 `config.json`：

```json
{
  "allowExec": ["git", "npm", "node", "python", "dir", "type"]
}
```

只放你允许的程序名，**不是任意命令**，也不走 shell（没有管道、重定向），所以注入不了。

## 五、安全设计

- **只绑局域网**，不监听公网
- **令牌 32 字节随机**，恒定时间比较
- **路径限制**在你主目录（`roots` 可改），挡 `../` 逃逸
- **命令白名单**，空着就是完全禁止
- **无 shell**，直接 execFile，不解析 `|` `>` `&&`

令牌泄露的后果：别人能读写你主目录下的文件。所以别截图发群。

## 六、停止

黑窗口里按 `Ctrl+C`，或者直接关窗口。

## 七、开机自启（可选）

按 `Win+R` 输入 `shell:startup`，把 `start.bat` 的快捷方式放进去。

## 八、接口

所有能力都是 `POST /<能力>`，带 `Authorization: Bearer <令牌>`。
`GET /health` 免令牌，用来让手机认出「这个 IP 上是不是 Sigma 客户端」。

```bash
curl -X POST http://192.168.1.100:8092/list \
  -H "Authorization: Bearer <令牌>" \
  -H "Content-Type: application/json" \
  -d '{"path":"~/Documents"}'
```
