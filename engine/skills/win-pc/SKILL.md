---
name: win-pc
description: 操作用户自己的 Windows 电脑——跑命令、装软件、找文件、发文件、控制鼠标键盘、看屏幕。用户说「我电脑上」「帮我打开」「在我电脑里找」时读。
version: 2.0.0
source: handwritten
permissions: [network, runs-commands, reads-files, writes-files]

---

# 用户的 Windows 电脑

用户的电脑上跑着 `SigmaClient.exe`，它对这台手机开放了完整控制权。
**你能在那台电脑上做的事，和一个坐在它前面的人一样多。**

前提：同一 Wi-Fi 直连，或走中继（配对码）。

---

## 先看有没有连

```sh
node "$DSH_TOOLS/win-pc/pc.mjs" status
node "$DSH_TOOLS/win-pc/pc.mjs" caps     # 这台电脑支持什么
```

没连过就走「首次连接」。

## 首次连接

用 `ask_user_question` 一项一项问，别一次抛一堆。

**同一 Wi-Fi**：问地址（`http://192.168.0.49:8092`）+ 令牌
**跨网络**：只问 6 位配对码 + 令牌，中继地址内置

```sh
node "$DSH_TOOLS/win-pc/pc.mjs" connect --url <地址> --token <令牌>
node "$DSH_TOOLS/win-pc/pc.mjs" connect --code <配对码> --token <令牌>
```

记住：**用户重装客户端后配对码和令牌都会变**。

## 能干什么（按使用频率排）

| 需求 | 命令 |
|---|---|
| **跑命令** | `pc.mjs run "dir /s /b *.pdf"` — 走 cmd，管道/重定向都能用 |
| **PowerShell** | `pc.mjs ps "Get-Process \| Sort CPU -Desc \| Select -First 5"` |
| **批量** | `pc.mjs batch "命令1" "命令2" "命令3"` — 一次往返跑多条，省时间 |
| **找文件** | `pc.mjs run "where /r C:\\Users *.pdf"` 或 `pc.mjs ps "Get-ChildItem -Recurse -Filter *.xlsx"` |
| **读文件** | `pc.mjs read "~/Documents/a.txt"` |
| **写文件** | `pc.mjs write "~/a.txt" --content "内容"` 或 `--from 本地文件` |
| **列目录** | `pc.mjs ls "~"` |
| **看屏幕** | 对话页顶部小窗；或 `pc.mjs run` 里查 |
| **点鼠标** | `pc.mjs mouse move 800 600` / `mouse click left` / `mouse scroll -3` |
| **打字** | `pc.mjs type "要输入的文字"` |
| **快捷键** | `pc.mjs key "CTRL+V"` / `key "ALT+TAB"` / `key "ENTER"` |
| **查做过什么** | `pc.mjs audit --n 20` |

## 常见任务的正确做法

### 找资料
```sh
pc.mjs ps "Get-ChildItem -Path C:\\Users -Recurse -Include *.pdf,*.docx -ErrorAction SilentlyContinue | Where LastWriteTime -gt (Get-Date).AddDays(-30) | Select FullName,Length,LastWriteTime | Format-Table -Auto"
```
**先缩小范围再看结果**，别一上来 `Get-ChildItem C:\ -Recurse`——那会跑几分钟。

### 装软件
```sh
pc.mjs ps "winget install --id Google.Chrome -e --silent --accept-package-agreements"
```
或者下载安装包后静默安装。**装之前问用户一句**。

### 发文件
没有直接的发文件 API，用两步：
```sh
pc.mjs read "~/报告.pdf"      # 取回内容（文本）
pc.mjs run "copy \\"~/报告.pdf\\" \\"D:\\共享\\""   # 或在电脑上转到别处
```
大文件走 `run` 调用 PowerShell 上传到网盘/发邮件更实际。

### 在微信里聊天
这条路**能用但不稳**：
```sh
pc.mjs run "start weixin://"                    # 打开微信
pc.mjs mouse click 200 300                      # 点某个会话
pc.mjs type "你好"                              # 打字
pc.mjs key "ENTER"                              # 发送
```
问题：**坐标依赖当前窗口位置和分辨率**，换个屏幕尺寸就点歪。
更稳的做法是让用户自己描述界面，或者用 PowerShell 调 UI Automation：
```sh
pc.mjs ps "Add-Type -AssemblyName UIAutomationClient; ..."
```
**先做一次截图确认位置，再点。**

### 跑渲染
```sh
pc.mjs run "cd D:\\project && npm run build"
pc.mjs batch "cd D:\\project" "npm install" "npm run render"
```
长任务用 `--timeout 300000`。

## 三条铁律

**1. 破坏性操作先问。** 删文件、卸软件、关机、改系统设置——先说清要做什么，等用户点头。
读操作（列目录、读文件、查进程）随便用。

**2. 打字内容不进日志。** 客户端只记录长度。但**你自己不要**把密码之类的写进对话。

**3. 坐标会变。** 涉及鼠标点击时，先用截图确认，别凭记忆点。

## 排查

```sh
pc.mjs status      # 在线吗
pc.mjs caps        # 这台电脑支持什么（exec 是否启用）
pc.mjs audit       # 刚才做了什么、有没有失败
```

- 「令牌不对」→ 客户端重装过，令牌变了
- 「没有这个配对码」→ 同上，配对码也变了
- 命令超时 → 那个程序可能在等输入；换 `ps` 或用带 `/y` 之类参数的版本
