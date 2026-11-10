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
| **下载文件** | `pc.mjs download <url> [保存路径]` — 大文件走这个，别用 run 调 curl |
| **读文件** | `pc.mjs read "~/Documents/a.txt"` |
| **取回文件** | `pc.mjs fetch "C:/.../shot.png" --out /tmp/shot.png` — 截图/产物拉到本地 |
| **截图** | `pc.mjs shot` — 返回路径+尺寸+字节数 |
| **写文件** | `pc.mjs write "~/a.txt" --content "内容"` 或 `--from 本地文件` |
| **列目录** | `pc.mjs ls "~"` |
| **看屏幕** | 对话页顶部小窗；或 `pc.mjs run` 里查 |
| **点鼠标** | `pc.mjs mouse move 800 600` / `mouse click left` / `mouse scroll -3` |
| **打字** | `pc.mjs type "要输入的文字"` |
| **快捷键** | `pc.mjs key "CTRL+V"` / `key "ALT+TAB"` / `key "ENTER"` |
| **查做过什么** | `pc.mjs audit --n 20` |

## 怎么想问题

**别问「我有什么工具」，问「人在这台电脑前会怎么做」。**

人找文件会先想「大概在哪个盘」，然后一层层看；你就 `Get-ChildItem` 带范围找。
人装软件会去官网下载双击；你就 `winget` 或下载后静默安装。
人在微信发消息会点开窗口、点输入框、打字、回车；你就 `mouse click` + `type` + `key ENTER`。
人要截图会按 Win+Shift+S；你就调 PowerShell 抓屏。

**没有现成路子时，PowerShell 几乎什么都能办：**

| 想做的事 | 用什么 |
|---|---|
| 操作界面元素 | UI Automation（`UIAutomationClient`） |
| 改系统设置 | 注册表 / `Set-ItemProperty` |
| 调 Office 文档 | COM（`New-Object -ComObject Word.Application`） |
| 发邮件 | `Send-MailMessage` 或 Outlook COM |
| 压缩解压 | `Compress-Archive` |
| 下载 | `Invoke-WebRequest` |
| 定时/计划 | `Register-ScheduledTask` |
| 看进程/端口 | `Get-Process` / `Get-NetTCPConnection` |
| 管理系统服务 | `Get-Service` / `Start-Service` |
| 查数据库 | `Invoke-Sqlcmd` 或 ADO.NET |

**写一段临时 PowerShell 就跑，不用怕「技能里没写」。** 那正是 `ps` 命令存在的意义。

## 几个容易踩的坑

**找文件别全盘扫。** `Get-ChildItem C:\ -Recurse` 能跑十分钟。
先问用户大概在哪，或者从 `~`、`Desktop`、`Documents`、`Downloads` 开始。

**点鼠标前先截图确认。** 坐标依赖分辨率和窗口位置，
凭记忆点必歪。先 `screen/one` 看一眼，算好坐标再点。

**装软件前问一句。** 装了什么会改系统状态，用户可能不想装。

**长任务用大 timeout。** 编译、渲染、下载可能几分钟，
`--timeout 300000`，并且告诉用户「正在跑，大概 X 分钟」。

**命令卡住多半在等输入。** 加 `/y`、`-Force`、`--yes` 这类参数；
或者用 `ps` 而不是 `run`（PowerShell 不读 stdin 的概率低一些）。

## 执行纪律：能自己解决的不许问用户

用户给的是**指令**，不是**讨论**。说「装 QQ」，就是要装好，不是问「要不要装」。

真机上这几件事反复发生，全都是自己给自己找麻烦：

| 现象 | 正确做法 |
|---|---|
| 下载 403，去问用户怎么办 | **加 User-Agent 重试**（CDN 拒绝默认 UA）；再不行换镜像源 |
| 命令里有引号导致 URL 错 | 用 `ps` 而不是 `run`——PowerShell 的 `-EncodedCommand` 不会碰引号 |
| 不确定链对不对 | 先 `Invoke-WebRequest -Method Head` 验一下，不要盲点 |
| 大文件超时 | 用 `pc.mjs download`（后台任务，立刻返回 jobId），别用 `run` 调 curl |
| 不知道按钮在哪 | `pc.mjs ps` 调 UI Automation 读控件树，别凭坐标猜 |

**只有这几种情况才问用户**：
1. 需要他的账号密码（比如登录微信）
2. 两个方案代价明显不同（删除 vs 保留）
3. 环境根本不支持（比如没装显卡驱动却要跑 CUDA）

除此之外，**自己想办法、自己验证、自己修**。卡住时先换一条路，不要停下来等。

## 临时文件只放临时目录

真机日志里用户的 `C:\Users\Administrator\` 根目录被塞了 `wins.ps1`、`mesa\`、
`_sigma_shot.png`（桌面）。**用户的用户目录不是你的工作区。**

规矩：

| 要写什么 | 写到哪里 |
|---|---|
| 临时脚本（.ps1/.bat） | `$env:TEMP\sigma-xxx.ps1` |
| 下载的安装包 | `$env:USERPROFILE\Downloads\` |
| 解压出来的工具 | `$env:LOCALAPPDATA\sigma-tools\` |
| 截图 | `$env:TEMP\`（`pc.mjs shot` 已经这么做了） |
| **绝对不要** | `C:\Users\<用户>\` 根目录、桌面、**盘符根目录（`C:\`、`D:\` 这一层）** |

**注意区分「C 盘」和「C 盘根目录」**：C 盘完全可以用，不能用的是最顶层。
用户只有一块 C 盘是常态（笔记本、云主机尤其如此），但 C 盘上有大量正常位置：

```
%LOCALAPPDATA%\sigma-tools\<名字>\   ← 工具、解压产物，首选
%TEMP%\sigma-xxx                     ← 临时脚本、截图
%USERPROFILE%\Downloads\             ← 下载的安装包
C:\Program Files\<厂商>\             ← 正经安装的软件
```

**盘符根目录为什么特别糟**：用户打开「此电脑」第一眼就看到；卸载时没人
记得删；容易和别的软件撞名；根目录 ACL 特殊，随手建的目录权限容易出问题。

真机日志里为了给 Blender 配软件渲染，建了 `C:\mesa` —— 就是踩了这个。


写完临时脚本要在收尾时删掉：

```sh
pc.mjs ps "Remove-Item '$env:TEMP\sigma-*.ps1' -Force -ErrorAction SilentlyContinue"
```

**用户看到自己桌面 / 用户目录多出一堆不认识的文件，会觉得这软件很脏。**

## 别在手机上替电脑试

**成果要在电脑上，就在电脑上做。** 手机（iSH）和电脑是两条完全不同的网络
路径——手机能连通不代表电脑能，反之亦然。真机日志里为了下 Blender：

```
先在手机里 curl 阿里云镜像  → 白费两轮
才想起 pc.mjs run "curl.exe ..."  → 一次就通
```

同理：查文件先 `pc.mjs ls`，不要先 `ls` 本地；跑脚本先 `pc.mjs ps`，
不要先在本机试。

**唯一的例外**：要判断「这个命令本身写对没写对」时，可以在本机快速验证语法，
但**网络访问、文件存在性、软件安装**这类必须直接在目标机上做。

## 严禁过度工程

真机日志里发生过：为了「下载 QQ」，模型去下载 msedgedriver、比对 Edge 版本、
启动无头浏览器、用 WebDriver 点官网按钮——折腾了十几轮还没下完。

**一个文件而已，不需要浏览器自动化。**

正确的优先级：

1. **直接 `download`**（客户端内置，带 UA、跟随跳转、后台任务）
   ```sh
   pc.mjs download "https://dldir1.qq.com/qqfile/qq/QQNT/Windows/QQ_9.9.37_241223_x64_01.exe"
   pc.mjs download-status <jobId>      # 查进度
   ```
2. **拿不到直链** → `ps` 里 `Invoke-WebRequest` 抓官网 HTML，正则出 `.exe` 链接
3. **官网要 JS 渲染** → 才考虑浏览器，而且只在**没有别的办法**时

**任何时候不要在客户电脑上装驱动、装自动化框架。** 那是给测试环境用的。

## 做完的东西要交到用户手上

用户说「在你电脑上做个 X 给我」——**做完不等于交付**。
文件躺在 `C:\Users\...\Desktop` 用户看不到，你要把它送到手机上。

```sh
# 1. 在电脑上做（生成、导出、截图都行）
pc.mjs ps "..."

# 2. 取回手机（自动落到 App 附件目录，并打印 minis:// 链接）
pc.mjs pull "C:/Users/Administrator/Desktop/报告.pdf"

# 3. 能预览的直接弹出来（html/svg/png/jpg/pdf/md）
preview.mjs open 报告.pdf --go
```

**`pull` 会打印 `minis://attachments/xxx`，那就是用户能点的链接。**

没有 `pull` 之前，模型只能用 `read` 硬拉，二进制被当文本读成乱码、
大文件还会截断——用户永远收不到成品。

### 什么能交

| 类型 | 怎么交 |
|---|---|
| 图片（png/jpg/webp） | `pull` 之后 `preview open --go`，直接显示 |
| PDF | 同上 |
| HTML | 同上 |
| 视频/音频/zip | `pull` 拿链接，告诉用户「点这个」 |
| 文字结果 | 直接写在回复里 |

**别让用户自己去电脑上找文件。** 他人在手机上，看不到那台电脑的桌面。

## 复杂 PowerShell 写成文件，别硬塞进命令行

真机日志里反复卡在这一类：

```sh
# 写的时候自以为没问题
pc.mjs ps "$b=[IO.File]::ReadAllBytes('C:\x'); $b[0..5]"
# 实际执行时 $b 被吃掉，返回空
# 而 run 里更要命：cmd 把每个 $ 都当字面量
pc.mjs run "powershell -Command $f=... "   →  =[IO.File]::OpenRead(...)   ← $f 没了
```

**穿四层转义（bash → JSON → cmd → PowerShell）几乎必错。**

正确做法：**写成本地 .ps1 文件，用 `psfile` 传过去。**

```sh
cat > /tmp/check.ps1 <<'PSEOF'
$b = [System.IO.File]::ReadAllBytes('C:\downloads\x.7z')
$b[0..5] -join ','
PSEOF
pc.mjs psfile /tmp/check.ps1
```

文件里的 `$`、引号、反引号**一个都不用转义**。

**只有一行、不含变量的简单命令**才用 `pc.mjs ps "..."`。

### 拿到空输出要当回事

```
工具完成 · ok · header=
```

`ok` 只代表进程退出码是 0，**不代表命令做对了**。
返回空值、只有一个换行、或明显缺字段时，先怀疑「变量没传进去 / 路径不存在」，
不要继续往下走——否则后面全建在错误前提上。

## 每一步都要「看」一眼，不要盲等

真机日志里反复出现这种：

```sh
sleep 60; pc.mjs ps "Get-Process *QQ*"    # 盲等一分钟，不知道中间发生了什么
```

**这是错的。** 你等 60 秒，可能第 3 秒就装好了，也可能第 3 秒就报错了——你都不知道。

正确节奏是**动作 → 立刻看 → 再决定**：

```sh
# 1. 发起动作（不阻塞）
pc.mjs ps "Start-Process 'C:\...\QQ.exe' -ArgumentList '/S'"

# 2. 立刻看一眼屏幕（不是等）
pc.mjs shot                          # 返回 PNG 路径 + 尺寸 + 字节数
pc.mjs ps "Get-Process *QQ* -ErrorAction SilentlyContinue | Select Name,Id"

# 3. 没出来 → 再等 2-3 秒看一次；出来了 → 往下走
```

**「等一下」只有在「知道要等多久」时才用**。不知道就每 2-3 秒看一次，
比你盲等 60 秒快得多，也安全得多。

### 截图的三种用法

| 目的 | 怎么做 |
|---|---|
| **确认界面变了** | `pc.mjs shot` 拿到路径，看尺寸/字节数是否变化 |
| **找按钮坐标** | 截图后用 `pc.mjs ps` 跑 UI Automation 读控件树，比看像素坐标可靠 |
| **出错时取证** | 截图留下现场，比读日志更直观 |

**注意**：当前模型不支持图像输入，`shot` 只返回路径和尺寸——所以别指望「看图」，
要靠 **UI Automation 读文字** 或 **进程/文件检查** 来验证。

## 验证：做完要比对，不是发出去就算

一条指令执行完，必须**确认结果真的发生了**：

```sh
# 装软件 → 查注册表/文件是否存在
pc.mjs ps "Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\* | Where DisplayName -like '*QQ*' | Select DisplayName,DisplayVersion"

# 下文件 → 查大小是否合理
pc.mjs ps "Get-Item '$env:USERPROFILE\Downloads\*.exe' | Select Name,Length"

# 改文件 → 读回来比对
pc.mjs read "~/x.txt"
```

**「命令退出码 0」不等于「事情做成了」。** 你要的是后者。

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
