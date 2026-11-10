#!/usr/bin/env node
/**
 * Sigma Windows 客户端 —— 只提供「被连接」的能力。
 *
 * 设计原则（很重要）：
 *   1. **零依赖**。客户装个 Node 就能跑，不需要 npm install。
 *      客户机器上装依赖是最容易失败的一步，能省就省。
 *   2. **默认只绑内网**。不开公网端口，不用管理员权限。
 *      跨网络请用 Tailscale（见 README），那是客户自己的账号，不经过我们。
 *   3. **不是任意命令执行**。`/exec` 只放行白名单里的可执行文件，
 *      而且默认关闭——要客户自己在 config 里打开。
 *   4. **令牌进文件，不进日志**。首次运行生成，之后复用。
 *
 * 启动后会在控制台打印：本机地址、令牌、配对码。
 * 手机端填「地址 + 令牌」即可连接。
 */

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import dgram from 'node:dgram';
import { execFile, spawn } from 'node:child_process';

// pkg 打成 exe 后，任何未捕获异常都会让窗口一闪就没了，
// 用户看到的是「双击闪退」，什么信息都没有。所以先装兜底：
// 把原因写进 exe 同目录的 crash.log，并且**不退出**，留住窗口。
const BOOT_DIR = typeof process.pkg !== 'undefined' ? path.dirname(process.execPath) : process.cwd();
function crashLog(err) {
  const text = `[${new Date().toISOString()}] ${err?.stack || err}\r\n`;
  try { fs.appendFileSync(path.join(BOOT_DIR, 'crash.log'), text); } catch { /* 写不了就算了 */ }
  try { console.error(text); } catch { /* 没有控制台 */ }
}
function keepWindow(why) {
  try {
    console.error('');
    console.error(`  ${why}：程序没有退出，详细信息在 crash.log`);
    console.error('  按 Ctrl+C 关闭窗口');
  } catch { /* 没有控制台 */ }
}
process.on('uncaughtException', (e) => { crashLog(e); keepWindow('运行时错误'); });
process.on('unhandledRejection', (e) => { crashLog(e); keepWindow('Promise 未处理'); });

// pkg 打包成 exe 后，import.meta.url 指向 `/snapshot/...`（只读虚拟文件系统），
// 往那里写 config.json 会抛 EROFS/EACCES —— 表现就是「双击闪退」。
// 所以 exe 模式下必须用 process.execPath 的目录（即 exe 所在目录）。
const PACKED = typeof process.pkg !== 'undefined';
const HERE = PACKED
  ? path.dirname(process.execPath)
  : path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(HERE, 'config.json');

// screen.ps1 的内容直接内嵌进源码：
// pkg 的 asset 方案要额外的 assets 配置，容易漏；内嵌成字符串最稳，
// exe 里一定拿得到。运行时写进临时目录再交给 PowerShell。
const EMBEDDED_SCREEN_PS1 = "# Sigma \u5c4f\u5e55\u91c7\u96c6 \u2014\u2014 \u6301\u7eed\u8f93\u51fa JPEG \u5e27\u5230 stdout\n#\n# \u4e3a\u4ec0\u4e48\u7528 PowerShell \u800c\u4e0d\u662f Node \u76f4\u63a5\u622a\u56fe\uff1a\n#   Node \u6ca1\u6709\u5185\u7f6e\u7684\u5c4f\u5e55\u6355\u83b7\u80fd\u529b\uff0c\u8981\u505a\u5c31\u5f97\u7f16\u8bd1 node-addon \u6216\u8005\u4f9d\u8d56\u539f\u751f\u6a21\u5757\uff0c\n#   \u800c\u5ba2\u6237\u7aef\u7684\u8bbe\u8ba1\u524d\u63d0\u662f\u300c\u96f6\u4f9d\u8d56\u3001\u5355\u6587\u4ef6 exe\u300d\u3002PowerShell \u5728\u6240\u6709 Windows \u4e0a\n#   \u90fd\u81ea\u5e26\uff0c.NET \u7684 System.Drawing \u80fd\u76f4\u63a5\u6293\u5c4f\u3002\n#\n# \u4e3a\u4ec0\u4e48\u662f**\u5e38\u9a7b\u8fdb\u7a0b**\u800c\u4e0d\u662f\u6bcf\u6b21\u8c03\u7528\uff1a\n#   \u6bcf\u6b21\u8d77\u4e00\u4e2a PowerShell \u8fdb\u7a0b\u8981 200-400ms\uff0c\u6700\u591a 3 \u5e27/\u79d2\uff1b\n#   \u5e38\u9a7b\u5faa\u73af\u80fd\u8fbe\u5230 10-15 \u5e27/\u79d2\uff0c\u8fd9\u624d\u662f\u300c\u89c6\u9891\u300d\u800c\u4e0d\u662f\u300c\u5e7b\u706f\u7247\u300d\u3002\n#\n# \u8f93\u51fa\u534f\u8bae\uff1a\u6bcf\u5e27\u524d\u6253\u5370 `--FRAME <\u5b57\u8282\u6570>`\uff0c\u7136\u540e\u5199\u539f\u59cb JPEG \u5b57\u8282\u3002\n#   \u7528\u957f\u5ea6\u524d\u7f00\u800c\u4e0d\u662f\u5206\u9694\u7b26\uff1aJPEG \u6570\u636e\u91cc\u4ec0\u4e48\u5b57\u8282\u90fd\u53ef\u80fd\u6709\uff0c\n#   \u5206\u9694\u7b26\u4f1a\u88ab\u8bef\u5224\uff0c\u957f\u5ea6\u524d\u7f00\u4e0d\u4f1a\u3002\n\nparam(\n  [int]$Fps = 12,\n  [int]$Quality = 55,\n  [double]$Scale = 0.5   # \u7f29\u5c0f\u4e00\u534a\uff1a1080p\u2192960x540\uff0c\u6d41\u91cf\u964d\u5230 1/4\uff0c\u8089\u773c\u770b\u76d1\u63a7\u591f\u7528\n)\n\n$ErrorActionPreference = 'Stop'\nAdd-Type -AssemblyName System.Drawing, System.Windows.Forms\n\n$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen\n$srcW = $bounds.Width\n$srcH = $bounds.Height\n$dstW = [int]($srcW * $Scale)\n$dstH = [int]($srcH * $Scale)\n\n$bmp = New-Object System.Drawing.Bitmap($srcW, $srcH)\n$gfx = [System.Drawing.Graphics]::FromImage($bmp)\n$small = New-Object System.Drawing.Bitmap($dstW, $dstH)\n$smallGfx = [System.Drawing.Graphics]::FromImage($small)\n$smallGfx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear\n\n$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |\n  Where-Object { $_.MimeType -eq 'image/jpeg' }\n$ep = New-Object System.Drawing.Imaging.EncoderParameters(1)\n$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(\n  [System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)\n\n# \u544a\u8bc9\u7236\u8fdb\u7a0b\u300c\u6211\u51c6\u5907\u597d\u4e86\u300d\uff0c\u9644\u4e0a\u771f\u5b9e\u5206\u8fa8\u7387\n[Console]::Out.WriteLine(\"--READY $dstW $dstH $Fps\")\n[Console]::Out.Flush()\n\n$stdout = [Console]::OpenStandardOutput()\n$interval = [int](1000 / [Math]::Max(1, $Fps))\n\nwhile ($true) {\n  $t0 = [Environment]::TickCount\n\n  try {\n    $gfx.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bmp.Size)\n    $smallGfx.DrawImage($bmp, 0, 0, $dstW, $dstH)\n\n    $ms = New-Object System.IO.MemoryStream\n    $small.Save($ms, $codec, $ep)\n    $bytes = $ms.ToArray()\n    $ms.Dispose()\n\n    $header = [Text.Encoding]::ASCII.GetBytes(\"--FRAME $($bytes.Length)`n\")\n    $stdout.Write($header, 0, $header.Length)\n    $stdout.Write($bytes, 0, $bytes.Length)\n    $stdout.Flush()\n  } catch {\n    # \u9501\u5c4f\u3001UAC \u63d0\u6743\u754c\u9762\u3001\u5207\u6362\u7528\u6237\u65f6\u4f1a\u6293\u4e0d\u5230\u753b\u9762\u3002\n    # \u62a5\u544a\u4e00\u6b21\u9519\u8bef\u4f46\u7ee7\u7eed\u8dd1\uff1a\u7528\u6237\u89e3\u9501\u540e\u753b\u9762\u4f1a\u81ea\u52a8\u6062\u590d\u3002\n    $msg = [Text.Encoding]::ASCII.GetBytes(\"--ERROR $($_.Exception.Message)`n\")\n    $stdout.Write($msg, 0, $msg.Length)\n    $stdout.Flush()\n  }\n\n  # \u6309\u76ee\u6807\u5e27\u7387\u8865\u9f50\u95f4\u9694\uff0c\u907f\u514d\u6293\u591a\u5feb\u5c31\u53d1\u591a\u5feb\uff08\u90a3\u4f1a\u5360\u6ee1 CPU\uff09\n  $elapsed = [Environment]::TickCount - $t0\n  $sleep = $interval - $elapsed\n  if ($sleep -gt 0) { Start-Sleep -Milliseconds $sleep }\n}\n";

// 输入控制脚本，同样内嵌：exe 里一定拿得到。
const EMBEDDED_INPUT_PS1 = "# Sigma \u8f93\u5165\u63a7\u5236 \u2014\u2014 \u9f20\u6807\u4e0e\u952e\u76d8\n#\n# \u4e3a\u4ec0\u4e48\u7528 PowerShell \u800c\u4e0d\u662f Node \u539f\u751f\u6a21\u5757\uff1a\n#   \u5ba2\u6237\u7aef\u7684\u8bbe\u8ba1\u524d\u63d0\u662f\u300c\u96f6\u4f9d\u8d56\u3001\u5355\u6587\u4ef6 exe\u300d\u3002SendInput/SetCursorPos \u662f\n#   user32.dll \u91cc\u7684 C \u63a5\u53e3\uff0cNode \u8c03\u4e0d\u5230\uff1bPowerShell \u7528 Add-Type \u7f16\u8bd1\u4e00\u5c0f\u6bb5\n#   P/Invoke \u58f0\u660e\u5c31\u80fd\u8c03\uff0c\u800c\u4e14\u6240\u6709 Windows \u90fd\u81ea\u5e26 PowerShell\u3002\n#\n# \u4e3a\u4ec0\u4e48\u6bcf\u6b21\u8c03\u7528\u8d77\u4e00\u4e2a\u8fdb\u7a0b\uff1a\n#   \u9f20\u6807\u70b9\u51fb\u662f\u4f4e\u9891\u4e8b\u4ef6\uff08\u4eba\u624b\u64cd\u4f5c\uff09\uff0c\u4e0d\u50cf\u5c4f\u5e55\u91c7\u96c6\u8981\u8fde\u7eed\u8dd1\u3002\n#   \u8d77\u8fdb\u7a0b\u7ea6 200-400ms\uff0c\u5bf9\u4eba\u673a\u4ea4\u4e92\u5b8c\u5168\u591f\u7528\uff1b\u5e38\u9a7b\u8fdb\u7a0b\u53cd\u800c\u8981\u7ef4\u62a4 IPC \u534f\u8bae\u3002\n#\n# \u7528\u6cd5\uff08\u53c2\u6570\u5f62\u5f0f\uff09\uff1a\n#   powershell -File input.ps1 -Action move -X 100 -Y 200\n#   powershell -File input.ps1 -Action click -Button left\n#   powershell -File input.ps1 -Action type -Text \"\u4f60\u597d\"\n#   powershell -File input.ps1 -Action key -Keys \"CTRL+V\"\n#   powershell -File input.ps1 -Action scroll -Delta -3\n#   powershell -File input.ps1 -Action screen      # \u8fd4\u56de\u5c4f\u5e55\u5c3a\u5bf8\n\nparam(\n  [Parameter(Mandatory = $true)][string]$Action,\n  [int]$X = 0,\n  [int]$Y = 0,\n  [string]$Button = 'left',\n  [string]$Text = '',\n  [string]$Keys = '',\n  [int]$Delta = 0,\n  [int]$MoveMs = 0\n)\n\n$ErrorActionPreference = 'Stop'\n\nAdd-Type -AssemblyName System.Windows.Forms\n\nif (-not ('SigmaInput' -as [type])) {\n  Add-Type -TypeDefinition @'\nusing System;\nusing System.Runtime.InteropServices;\npublic class SigmaInput {\n  [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x, int y);\n  [DllImport(\"user32.dll\")] public static extern bool GetCursorPos(out POINT p);\n  [DllImport(\"user32.dll\")] public static extern void mouse_event(uint f, int dx, int dy, int d, IntPtr e);\n  [DllImport(\"user32.dll\")] public static extern void keybd_event(byte k, byte s, uint f, IntPtr e);\n  [DllImport(\"user32.dll\")] public static extern short VkKeyScan(char ch);\n  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }\n\n  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;\n  public const uint RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;\n  public const uint MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040;\n  public const uint WHEEL = 0x0800, HWHEEL = 0x1000;\n  public const uint KEYUP = 0x0002;\n}\n'@\n}\n\n$si = [SigmaInput]\n\nswitch ($Action) {\n\n  'screen' {\n    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen\n    \"{`\"ok`\":true,`\"width`\":$($b.Width),`\"height`\":$($b.Height),`\"x`\":$($b.X),`\"y`\":$($b.Y)}\"\n  }\n\n  'pos' {\n    $p = New-Object SigmaInput+POINT\n    [void][SigmaInput]::GetCursorPos([ref]$p)\n    \"{`\"ok`\":true,`\"x`\":$($p.X),`\"y`\":$($p.Y)}\"\n  }\n\n  'move' {\n    # MoveMs > 0 \u65f6\u505a\u5e73\u6ed1\u79fb\u52a8\uff1a\u5f88\u591a\u7a0b\u5e8f\uff08\u6e38\u620f\u3001\u753b\u677f\uff09\u53ea\u8ba4\u8fde\u7eed\u79fb\u52a8\u4e8b\u4ef6\uff0c\n    # \u77ac\u79fb\u4f1a\u88ab\u5ffd\u7565\u6216\u5f53\u6210\u62d6\u62fd\u3002\n    if ($MoveMs -gt 0) {\n      $p = New-Object SigmaInput+POINT\n      [void][SigmaInput]::GetCursorPos([ref]$p)\n      $steps = [Math]::Max(6, [int]($MoveMs / 12))\n      for ($i = 1; $i -le $steps; $i++) {\n        $nx = [int]($p.X + ($X - $p.X) * $i / $steps)\n        $ny = [int]($p.Y + ($Y - $p.Y) * $i / $steps)\n        [void][SigmaInput]::SetCursorPos($nx, $ny)\n        Start-Sleep -Milliseconds ([Math]::Max(1, [int]($MoveMs / $steps)))\n      }\n    }\n    [void][SigmaInput]::SetCursorPos($X, $Y)\n    \"{`\"ok`\":true,`\"x`\":$X,`\"y`\":$Y}\"\n  }\n\n  'click' {\n    $down = $si::LEFTDOWN; $up = $si::LEFTUP\n    if ($Button -eq 'right')  { $down = $si::RIGHTDOWN;  $up = $si::RIGHTUP }\n    if ($Button -eq 'middle') { $down = $si::MIDDLEDOWN; $up = $si::MIDDLEUP }\n    [void][SigmaInput]::SetCursorPos($X, $Y)\n    Start-Sleep -Milliseconds 40\n    [SigmaInput]::mouse_event($down, 0, 0, 0, [IntPtr]::Zero)\n    Start-Sleep -Milliseconds 40\n    [SigmaInput]::mouse_event($up, 0, 0, 0, [IntPtr]::Zero)\n    \"{`\"ok`\":true,`\"button`\":`\"$Button`\",`\"x`\":$X,`\"y`\":$Y}\"\n  }\n\n  'dblclick' {\n    [void][SigmaInput]::SetCursorPos($X, $Y)\n    for ($i = 0; $i -lt 2; $i++) {\n      [SigmaInput]::mouse_event($si::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)\n      [SigmaInput]::mouse_event($si::LEFTUP, 0, 0, 0, [IntPtr]::Zero)\n      Start-Sleep -Milliseconds 60\n    }\n    \"{`\"ok`\":true}\"\n  }\n\n  'down' {\n    [SigmaInput]::mouse_event($si::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)\n    \"{`\"ok`\":true}\"\n  }\n\n  'up' {\n    [SigmaInput]::mouse_event($si::LEFTUP, 0, 0, 0, [IntPtr]::Zero)\n    \"{`\"ok`\":true}\"\n  }\n\n  'scroll' {\n    # Delta \u5355\u4f4d\u662f\u300c\u683c\u300d\uff0c\u6b63\u6570\u5411\u4e0a\u3002Windows \u7684 wheel \u53c2\u6570\u662f 120 \u7684\u500d\u6570\u3002\n    [SigmaInput]::mouse_event($si::WHEEL, 0, 0, ($Delta * 120), [IntPtr]::Zero)\n    \"{`\"ok`\":true,`\"delta`\":$Delta}\"\n  }\n\n  'type' {\n    # \u4e2d\u6587\u5fc5\u987b\u8d70 SendKeys \u7684\u526a\u8d34\u677f\u5916\u8def\u5f84 \u2014\u2014 \u76f4\u63a5\u7528 VkKeyScan \u53ea\u80fd\u6253\u82f1\u6587\u3002\n    # SendKeys \u652f\u6301\u4e00\u90e8\u5206 Unicode\uff0c\u4f46\u6162\uff1b\u5bf9\u4e2d\u6587\u66f4\u53ef\u9760\u7684\u662f\u5148\u5199\u526a\u8d34\u677f\u518d Ctrl+V\u3002\n    if ($Text -match '[^\\x00-\\x7F]') {\n      Set-Clipboard -Value $Text\n      Start-Sleep -Milliseconds 120\n      [System.Windows.Forms.SendKeys]::SendWait('^v')\n    } else {\n      [System.Windows.Forms.SendKeys]::SendWait($Text)\n    }\n    \"{`\"ok`\":true,`\"len`\":$($Text.Length)}\"\n  }\n\n  'key' {\n    # \u652f\u6301 \"CTRL+V\"\u3001\"ENTER\"\u3001\"ALT+TAB\" \u8fd9\u79cd\u7ec4\u5408\n    [System.Windows.Forms.SendKeys]::SendWait($Keys)\n    \"{`\"ok`\":true,`\"keys`\":`\"$Keys`\"}\"\n  }\n\n  default {\n    \"{`\"ok`\":false,`\"error`\":`\"\u672a\u77e5\u52a8\u4f5c: $Action`\"}\"\n    exit 1\n  }\n}\n";

const PORT = Number(process.env.SIGMA_WIN_PORT || 8092);
const BEACON_PORT = Number(process.env.SIGMA_WIN_BEACON || 8099);
const IS_WIN = process.platform === 'win32';
// 内置中继地址：客户不用填，也不要求注册。
// 想换成自己的中继，改 config.json 的 relay 字段即可。
const DEFAULT_RELAY = 'ws://202.189.51.44:8791';

// ── 配置：首次运行生成令牌 ────────────────────────────────────────────
function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (c.token && typeof c.token === 'string') return c;
    } catch { /* 坏文件就重建 */ }
  }
  const token = crypto.randomBytes(24).toString('base64url');
  const cfg = {
    token,
    name: os.hostname(),
    // 允许执行的命令（可执行文件名，不含参数）。默认空 = 完全禁止。
    // 客户自己往里加。空着也能用文件读写，只是不能跑命令。
    // 执行模式：
    //   'all'       —— 能跑任何命令（默认）。这是用户明确要的「电脑能干活」。
    //   'whitelist' —— 只跑 allowExec 里的程序。
    // 无论哪种模式，每条命令都写审计日志。
    execMode: 'all',
    allowExec: [],
    // 访问白名单。**留空 = 全盘可访问**（默认），要收紧就填具体目录。
    roots: [],
    // 中继：跨网络时用。空字符串 = 只用局域网。
    relay: DEFAULT_RELAY,
    // 配对码：**由令牌派生，重装/重启都不变**。
    // 之前是每次启动随机生成，用户重装客户端后手机上存的旧码就失效，
    // 表现为「明明中继已上线却一直 404」——这个坑踩了好几次。
    // 现在固定 = 令牌前 6 位转大写，装一百次都是同一个码。
    code: '',   // 留空，下面用令牌算出来
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return cfg;
}

const CONFIG = loadConfig();

// 配对码永远由令牌派生：装一次和装一百次得到同一个码，
// 用户手机上存的配置不会因为重装而失效。
if (!CONFIG.code && CONFIG.token) {
  const map = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const hex = crypto.createHash('sha256').update(CONFIG.token).digest();
  CONFIG.code = Array.from({ length: 6 }, (_, i) => map[hex[i] % map.length]).join('');
}

// ── 工具 ──────────────────────────────────────────────────────────────
function json(res, code, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    // 手机 App 走局域网，不需要 CORS；但 WebView 里可能要用，放开无妨（有令牌兜底）。
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(data);
}

/** 恒定时间比较，避免按字节猜测令牌。 */
function tokenOk(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(CONFIG.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 把相对路径解析到允许的根目录下，挡住 ../ 逃逸。 */
/**
 * 解析路径。
 *
 * **不再限制在用户主目录内。** 用户要的是「像坐在电脑前一样」的全部权限，
 * 而主目录之外还有大量真实资料：`C:\Users\Public\Desktop`（公用桌面）、
 * `D:\`（数据盘）、`C:\ProgramData`、网络共享……
 * 之前的白名单只放行 home，于是「列桌面」只能看到 Administrator 的那一个，
 * 公用桌面的快捷方式全被挡在外面——这不是权限问题，是我写错了。
 *
 * `roots` 现在只在**显式配置**时才作为白名单生效（留空 = 全盘可访问）。
 */
function safePath(p) {
  // 先展开 ~：客户和模型都会写 `~\Documents`，不展开会变成「主目录下名叫 ~ 的目录」
  let raw = String(p || '.').trim();
  if (raw === '~') raw = os.homedir();
  else if (raw.startsWith('~/') || raw.startsWith('~\\')) raw = path.join(os.homedir(), raw.slice(2));
  // 支持 %USERPROFILE% 这类 Windows 环境变量
  if (IS_WIN) raw = raw.replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m);
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(os.homedir(), raw);

  // 只有显式配置了 roots 才当白名单用；默认空 = 全盘
  const roots = (CONFIG.roots || []).filter((r) => typeof r === 'string' && r.trim());
  if (roots.length === 0) return abs;
  const resolved = roots.map((r) => path.resolve(r));
  const ok = resolved.some((r) => abs === r || abs.startsWith(r + path.sep));
  if (!ok) throw new Error(`路径不在允许范围内：${abs}（roots: ${resolved.join(', ')}）`);
  return abs;
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

/**
 * 取内嵌脚本的真实路径。
 *
 * pkg 打成 exe 后，内嵌资源在只读虚拟文件系统里，而 PowerShell 的 -File
 * 需要一个真实路径——所以写到临时目录再用。文件名带 pid，避免多开冲突。
 */
function resolveEmbedded(name, content) {
  const beside = path.join(HERE, name);
  if (fs.existsSync(beside)) return beside;
  const tmp = path.join(os.tmpdir(), `sigma-${process.pid}-${name}`);
  if (!fs.existsSync(tmp)) {
    // ⚠ 必须写 BOM。
    // Windows PowerShell 5.1 读 .ps1 时，没有 BOM 就按**系统 ANSI 代码页**
    // （中文机是 GBK）解析。我们的脚本是 UTF-8，于是里面每一个中文字面量
    // 都会在**加载阶段**就变成乱码——用 SendKeys 打出来当然也是乱码。
    // 加 BOM（EF BB BF）后 PowerShell 才认它是 UTF-8。
    fs.writeFileSync(tmp, '\uFEFF' + content, 'utf8');
  }
  return tmp;
}

/**
 * 输入操作的审计日志。
 *
 * 为什么要记：鼠标键盘是全权限操作，出了事（点错、误删）必须能回溯
 * 「当时动了哪里」。只记时间和动作，不记打字内容（可能是密码）。
 */
/**
 * 统一审计：所有「对电脑产生副作用」的操作都从这里走。
 *
 * 只记结构化摘要，不记可能含密码的明文（打字内容只记长度）。
 * 日志在 exe 同目录的 audit.log，一行一条 JSON，方便 grep/转发。
 */
/**
 * 清掉 PowerShell 塞进 stderr 的 CLIXML 序列化块。
 *
 * 用 `-EncodedCommand` + 重定向时，PowerShell 会把错误/进度对象序列化成
 * `#< CLIXML ... <Objs Version="1.1.0.1" ...>...</Objs>` 这样的 XML，
 * 混在正常输出里非常难看，也让模型误判「有错误」。
 *
 * 只删这一段，真正的 stderr 文本保留。
 */
function stripClixml(text) {
  if (typeof text !== 'string' || !text.includes('CLIXML')) return text;
  return text
    // 去掉整段 <Objs ...>...</Objs>
    .replace(/#< CLIXML[\s\S]*?<\/Objs>/g, '')
    // 去掉残留的单行标记
    .replace(/^#< CLIXML\s*$/gm, '')
    .replace(/<Objs[\s\S]*?<\/Objs>/g, '')
    .trim();
}

function audit(entry) {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(path.join(HERE, 'audit.log'), line);
    auditRing.push(line);
    if (auditRing.length > 500) auditRing.shift();
  } catch { /* 审计失败不阻断 */ }
}
const auditRing = [];

function auditInput(action, args) {
  // 打字内容只记长度，绝不落盘明文——那里可能是密码
  audit({
    kind: 'input', action,
    textLen: args.text ? String(args.text).length : 0,
    keys: args.keys || undefined,
    x: args.x, y: args.y, button: args.button, delta: args.delta,
  });
}

// ── 中继隧道（多路复用） ──────────────────────────────────────────────
//
// 每个 HTTP 请求一个 rid，各自开一条到本机 HTTP 的 TCP。
// 为什么不用一条共享连接：App 会同时发 /health 和 /screen（MJPEG 永不结束），
// 共享连接时两个响应会互相踩，表现是「连上了但立刻中断」。
//
// 协议（与中继一致）：
//   收到 {"type":"req","rid":N} → 准备好接下一帧二进制（HTTP 请求）
//   收到二进制              → 写进该 rid 的 TCP
//   TCP 有数据回来          → {"type":"res","rid":N} + 二进制帧
//   TCP 关闭                → {"type":"end","rid":N}

let relayWS = null;
let relayState = 'off';
let relayError = null;
const tunnels = new Map();   // rid -> { sock }
let pendingRid = null;
let currentRid = null;

function sendText(obj) {
  if (relayWS && relayWS.readyState === 1) relayWS.send(JSON.stringify(obj));
}
function sendBinary(buf) {
  if (relayWS && relayWS.readyState === 1) {
    relayWS.send(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }
}

function openTunnelFor(rid) {
  const sock = net.connect(PORT, '127.0.0.1');
  sock.setNoDelay(true);
  tunnels.set(rid, { sock });
  sock.on('data', (d) => {
    sendText({ type: 'res', rid });
    sendBinary(d);
  });
  const close = () => {
    if (tunnels.delete(rid)) sendText({ type: 'end', rid });
  };
  sock.on('close', close);
  sock.on('error', close);
  return sock;
}

function closeAllTunnels() {
  for (const [, t] of tunnels) { try { t.sock.destroy(); } catch { /* 已断 */ } }
  tunnels.clear();
}

function connectRelay() {
  const url = CONFIG.relay;
  if (!url || relayState === 'connecting' || relayState === 'online') return;
  if (typeof WebSocket === 'undefined') {
    relayState = 'error';
    console.log('  中继    不可用：这个 Node 版本没有内置 WebSocket');
    return;
  }

  relayState = 'connecting';
  relayError = null;
  let ws;
  try { ws = new WebSocket(url); } catch (e) { relayState = 'error'; relayError = e.message; return; }
  ws.binaryType = 'arraybuffer';

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ role: 'host', code: CONFIG.code, meta: { name: CONFIG.name, platform: process.platform } }));
  });

  ws.addEventListener('message', (evt) => {
    if (typeof evt.data === 'string') {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'registered') {
          relayState = 'online';
          console.log(`  中继    已上线（配对码 ${CONFIG.code}）`);
        } else if (msg.type === 'req') {
          pendingRid = msg.rid;
        } else if (msg.type === 'end') {
          if (currentRid === msg.rid) currentRid = null;
        } else if (msg.type === 'reset') {
          closeAllTunnels();
        }
      } catch { /* 非 JSON：丢弃 */ }
      return;
    }
    // 二进制帧：属于当前 rid。
    //
    // 中继可能把一个 HTTP 请求拆成**多个** WebSocket 帧发过来
    // （请求头一帧、body 一帧，或大 body 分几帧）。
    // 之前只在收到 req 后的第一帧写进 TCP，后续帧被丢弃 ——
    // 客户端拿到 Content-Length 比实际 body 大的请求，一直等剩下的字节，
    // 最后超时。表现就是「GET 能通、POST 全超时」。
    const buf = Buffer.from(evt.data);
    if (pendingRid !== null) {
      const rid = pendingRid;
      pendingRid = null;
      currentRid = rid;
      openTunnelFor(rid);          // 建连接并登记
    }
    if (currentRid !== null) {
      const t = tunnels.get(currentRid);
      if (t) { try { t.sock.write(buf); } catch { /* 已断，close 会清 */ } }
    }
  });

  let closedByUs = false;
  const scheduleRetry = () => {
    if (closedByUs) return;
    relayWS = null;
    closeAllTunnels();
    relayState = 'off';
    setTimeout(() => { if (!relayWS) connectRelay(); }, 5000);
  };
  ws.addEventListener('close', scheduleRetry);
  ws.addEventListener('error', (e) => {
    relayState = 'error';
    relayError = (e && e.message) || '连不上中继';
    console.log(`  中继    连接失败：${relayError}（5 秒后重试）`);
  });
  process.on('exit', () => { closedByUs = true; });

  relayWS = ws;
}

function renderBanner() {}

// ── 屏幕流（MJPEG） ───────────────────────────────────────────────────
//
// 为什么用 MJPEG 而不是 H.264：
//   客户端是零依赖的 Node 单文件，做 H.264 就得打包 ffmpeg（+80MB）或者
//   写 node-addon。MJPEG 就是连续的 JPEG 帧，PowerShell 抓屏直接出 JPEG，
//   不需要任何编码器；iOS 的 UIImage/AsyncImage 也能逐帧解。
//   代价是流量大 3-5 倍，但局域网无所谓，而且只在你打开预览时才推。
//
// 生命周期：第一个观看者连上才启动 PowerShell，最后一个断开就杀掉。
//   不让它常驻——没人看的时候一直抓屏是白烧 CPU 和电。

// 1x1 白色 JPEG（最小的合法 JPEG，105 字节）。
// 用途：流刚建立时先吐一帧，保证响应头马上离开缓冲区。
const PLACEHOLDER_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

// ── 双锁 ──────────────────────────────────────────────────────────────
//
// 借鉴 computer-use-for-all-agents 的做法：不用一把全局锁。
// 一次屏幕采集要几百毫秒到几秒，如果和鼠标点击共用一把锁，
// 用户点一下要等截图跑完——手感极差。
//   输入锁：鼠标、键盘（短操作，必须快）
//   读取锁：截图、目录列举（慢，但不该挡住输入）
class Mutex {
  constructor() { this.q = Promise.resolve(); }
  run(fn) {
    const next = this.q.then(fn, fn);
    // 无论成败都推进队列，避免一次失败把后续全堵死
    this.q = next.then(() => {}, () => {});
    return next;
  }
}
const inputLock = new Mutex();
const readLock = new Mutex();

/** 下载任务表：jobId -> { id, url, path, status, bytes, error, startedAt } */
const downloadJobs = new Map();

// ── 卡键看门狗 ────────────────────────────────────────────────────────
//
// 为什么必须有：input 支持 keydown/click-down 这类「按下不松」的操作。
// 如果 agent 按下 Ctrl 之后崩了、或者网络断了，Ctrl 会**一直被按住**，
// 用户整台电脑的键盘就废了——点击变成多选、打字变成快捷键。
//
// 这是唯一会造成「用户电脑不可用」的缺陷，所以服务端强制兜底：
//   · 记录每个被按下的键/按钮
//   · 30 秒内没有任何新输入 → 全部释放
//   · 提供 /release_all 让用户手动解卡
const heldInputs = new Map();   // key -> 按下时间
const WATCHDOG_MS = 30_000;

function noteHeld(key) { heldInputs.set(key, Date.now()); }
function clearHeld(key) { heldInputs.delete(key); }

let watchdogBusy = false;
const watchdog = setInterval(async () => {
  if (watchdogBusy || heldInputs.size === 0) return;
  const now = Date.now();
  let stale = false;
  for (const [, at] of heldInputs) {
    if (now - at > WATCHDOG_MS) { stale = true; break; }
  }
  if (!stale) return;
  watchdogBusy = true;
  try {
    await runInputScript('release_all');
    heldInputs.clear();
    audit({ kind: 'watchdog', action: 'release_all', reason: '30 秒无输入' });
    console.log('  看门狗  已释放所有卡住的按键');
  } catch { /* 下次再试 */ }
  watchdogBusy = false;
}, 5000);
if (typeof watchdog.unref === 'function') watchdog.unref();

/** 直接跑 input.ps1 的某个动作（给看门狗和 /release_all 用）。 */
function runInputScript(action) {
  const ps = IS_WIN ? 'powershell.exe' : 'pwsh';
  const script = resolveEmbedded('input.ps1', EMBEDDED_INPUT_PS1);
  return new Promise((resolve, reject) => {
    execFile(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Action', action, '-X', '0', '-Y', '0', '-Button', 'left',
      '-Text', '', '-Keys', '', '-Delta', '0', '-MoveMs', '0'],
      { timeout: 15000, windowsHide: true }, (err, stdout) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(String(stdout).trim().split('\n').pop())); }
        catch { resolve({ ok: true }); }
      });
  });
}

let screenProc = null;
let screenInfo = null;      // { w, h, fps }
let screenClients = new Set();
let screenFrame = null;     // 最近一帧，新连接立刻有画面
let screenErr = null;

function ensureScreen() {
  if (screenProc) return screenProc;
  const ps = process.env.SIGMA_SCREEN_SHELL || (IS_WIN ? 'powershell.exe' : 'pwsh');
  // screen.ps1 的取法有两种：
  //   · exe 模式：pkg 把它作为 asset 打进了虚拟文件系统，从 __dirname 读
  //   · 源码模式：就在同目录
  // 之前只认磁盘文件，exe 里当然找不到 —— 一点「屏幕预览」就抛错。
  const scriptPath = process.env.SIGMA_SCREEN_SCRIPT
    || resolveEmbedded('screen.ps1', EMBEDDED_SCREEN_PS1);


  // 参数顺序有讲究：
  //   Windows 的 powershell -File 后面**不能再跟任何 - 开头的开关**，否则它会把
  //   参数当成 powershell 自己的开关（实测报 `illegal option -N`，因为 -NoProfile
  //   被当成了脚本参数）。所以 -NoProfile / -ExecutionPolicy 必须放在 -File 前面。
  //   非 Windows（测试用）走 sh，参数是另一套。
  const args = process.env.SIGMA_SCREEN_SCRIPT
    ? [scriptPath]
    : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
       '-Fps', String(CONFIG.screenFps || 12),
       '-Quality', String(CONFIG.screenQuality || 70),
       '-Scale', String(CONFIG.screenScale || 1.0)];

  const child = spawn(ps, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = Buffer.alloc(0);
  let need = -1;

  child.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (need < 0) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        const line = buf.subarray(0, nl).toString('ascii').trim();
        buf = buf.subarray(nl + 1);
        if (line.startsWith('--FRAME ')) {
          need = Number(line.slice(8)) || 0;
        } else if (line.startsWith('--READY ')) {
          const [, w, h, fps, sw, sh] = line.split(' ');
          screenInfo = { w: Number(w), h: Number(h), fps: Number(fps),
            screenW: Number(sw) || null, screenH: Number(sh) || null };
          // 采集尺寸 ≠ 物理尺寸 → DPI 感知没生效，画面会只截到一角
          if (sw && Number(sw) !== Number(w)) {
            console.log(`  ⚠ 屏幕 ${sw}x${sh} 但采集只有 ${w}x${h}（DPI 未生效）`);
          }
        } else if (line.startsWith('--ERROR ')) {
          screenErr = line.slice(8);
        } else if (line.trim() === '') {
          // 空行：继续，不要退化成「等数据」的状态
          continue;
        }
        // 关键：解析完一行必须继续循环，否则当缓冲里已经带了
        // 帧头（--FRAME N）+ 完整帧时，会停在这里等下一次 data 事件，
        // 而那一帧其实已经在 buf 里了 —— 表现为「一直没画面」。
        continue;
      } else {
        if (buf.length < need) return;
        screenFrame = buf.subarray(0, need);
        buf = buf.subarray(need);
        need = -1;
        for (const res of screenClients) res.write(screenFrame, () => {});
      }
    }
  });

  child.stderr.on('data', (d) => { screenErr = String(d).slice(0, 300); });
  child.on('exit', () => { screenProc = null; });
  screenProc = child;
  return child;
}

function stopScreenIfIdle() {
  if (screenClients.size === 0 && screenProc) {
    try { screenProc.kill(); } catch { /* 已退出 */ }
    screenProc = null;
    screenFrame = null;
    screenInfo = null;
  }
}

/**
 * 输入控制的真正实现。
 *
 * 为什么不在 CAPS 对象里写成 this._input：CAPS 是对象字面量，
 * 解构 `const { input } = CAPS` 或经代理调用后 `this` 会丢，
 * 报 `Cannot read properties of undefined (reading '_input')`。
 * 提成模块级函数最稳。
 */
async function doInput({ action, x = 0, y = 0, button = 'left', text = '', keys = '', delta = 0, moveMs = 0 } = {}) {
    const ALLOWED = ['move', 'click', 'dblclick', 'down', 'up', 'scroll', 'type', 'key', 'keydown', 'keyup', 'release_all', 'screenshot', 'screen', 'pos'];
    if (!ALLOWED.includes(action)) throw new Error(`不支持的动作：${action}`);

    const ps = IS_WIN ? 'powershell.exe' : 'pwsh';
    const script = resolveEmbedded('input.ps1', EMBEDDED_INPUT_PS1);
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Action', action,
      '-X', String(Math.round(Number(x) || 0)),
      '-Y', String(Math.round(Number(y) || 0)),
      '-Button', String(button),
      '-Text', String(text),
      '-Keys', String(keys),
      '-Delta', String(Math.round(Number(delta) || 0)),
      '-MoveMs', String(Math.round(Number(moveMs) || 0))];

    // 记录「按下不松」的状态，交给看门狗兜底
    if (action === 'down') noteHeld('mouse:left');
    if (action === 'keydown') noteHeld('key:' + String(keys).toLowerCase());
    if (action === 'keyup') clearHeld('key:' + String(keys).toLowerCase());
    if (action === 'release_all') heldInputs.clear();

    auditInput(action, { x, y, button, text, keys, delta });

    return await new Promise((resolve, reject) => {
      execFile(ps, args, { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          const text = String(stdout || '').trim();
          // 脚本总是输出一行 JSON；解析失败就说明 PowerShell 本身出错了
          try { resolve(JSON.parse(text.split('\n').pop())); }
          catch { reject(new Error(text || String(err?.message || '输入控制失败'))); }
        });
    });

}

// ── 能力 ──────────────────────────────────────────────────────────────
const CAPS = {
  async info() {
    return {
      name: CONFIG.name,
      platform: process.platform,
      release: os.release(),
      arch: os.arch(),
      hostname: os.hostname(),
      cpus: os.cpus().length,
      memGB: Math.round(os.totalmem() / 1e9),
      freeGB: Math.round(os.freemem() / 1e9),
      home: os.homedir(),
      node: process.version,
      addresses: lanAddresses(),
      // execEnabled 现在由 execMode 决定，不再是「白名单非空」
      execEnabled: CONFIG.execMode === 'all' || (CONFIG.allowExec || []).length > 0,
      execMode: CONFIG.execMode || 'all',
      execAllowed: CONFIG.allowExec || [],
    };
  },

  async list({ path: p = '.' } = {}) { return readLock.run(async () => {
    const abs = safePath(p);
    const items = fs.readdirSync(abs, { withFileTypes: true }).map((e) => {
      let size = 0;
      try { size = e.isFile() ? fs.statSync(path.join(abs, e.name)).size : 0; } catch { /* 权限不足 */ }
      return { name: e.name, dir: e.isDirectory(), size };
    });
    // 目录在前，再按名字排，便于人读。
    items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    return { path: abs, count: items.length, items: items.slice(0, 500) };
    }); },

  /**
   * 读文件。
   *
   * base64=true 时按二进制读并编码——取截图、取构建产物必须走这条，
   * 否则 `readFileSync(abs,'utf8')` 会把 PNG/zip 变成一堆乱码。
   */
  async read({ path: p, maxBytes = 256 * 1024, base64 = false } = {}) {
    const abs = safePath(p);
    const stat = fs.statSync(abs);
    if (!stat.isFile()) throw new Error('不是文件');

    const buf = fs.readFileSync(abs);
    const truncated = buf.length > maxBytes;
    const slice = truncated ? buf.subarray(0, maxBytes) : buf;

    return {
      path: abs,
      size: stat.size,
      truncated,
      encoding: base64 ? 'base64' : 'utf8',
      content: base64 ? slice.toString('base64') : slice.toString('utf8'),
    };
  },

  /**
   * 写文件。
   *
   * encoding='base64' 时按二进制落盘——传图片、PDF、zip 必须走这条，
   * 否则内容会被当文本写坏。
   */
  async write({ path: p, content = '', encoding = 'utf8' } = {}) {
    const abs = safePath(p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (encoding === 'base64') {
      const buf = Buffer.from(String(content), 'base64');
      fs.writeFileSync(abs, buf);
      return { path: abs, bytes: buf.length, encoding: 'base64' };
    }
    fs.writeFileSync(abs, String(content), 'utf8');
    return { path: abs, bytes: Buffer.byteLength(String(content), 'utf8'), encoding: 'utf8' };
  },

  /**
   * 跑命令。默认禁用，而且只认白名单里的可执行文件。
   *
   * 为什么不做「任意命令」：这是客户自己的电脑，一旦令牌泄露，
   * 任意执行等于把整台机器交出去。白名单让人能明确知道放出去了什么。
   */
  /**
   * 鼠标键盘控制。
   *
   * 和 exec 的区别：exec 是「跑一个程序」，这是「操作当前桌面」——
   * 移动光标、点击、打字。等同于用户亲手操作，对系统是全权限的。
   *
   * 安全取舍：这个能力**不设白名单**（设了就没法用），所以它比 exec 更危险。
   * 防护靠三件事：令牌、局域网/中继二选一、以及每次调用都写审计日志。
   */
  async input({ action, x = 0, y = 0, button = 'left', text = '', keys = '', delta = 0, moveMs = 0, expectHwnd = null } = {}) {
    // 守卫：发送输入前确认前台窗口是预期的那一个。
    // 不做的话，agent 算好坐标、用户切了窗口，点击就落到别处——
    // 可能点进微信、点掉一个对话框。这个检查很便宜，但能挡掉最糟的情况。
    if (expectHwnd && ['type', 'key', 'keydown', 'keyup', 'click', 'dblclick'].includes(action)) {
      const fg = await runInputScript('foreground');
      if (fg && fg.ok && String(fg.hwnd) !== String(expectHwnd)) {
        throw new Error(`前台窗口不对（当前：${fg.title}）。目标已切走，拒绝输入。`);
      }
    }
    return inputLock.run(() => doInput({ action, x, y, button, text, keys, delta, moveMs }));
  },


  /**
   * 跑命令。
   *
   * 和旧版的区别：
   *   · **走真正的 shell**（Windows 用 cmd /c，其他用 sh -c），所以管道、
   *     重定向、`&&`、通配符全都能用。旧版用 execFile 直调，等于半个残废，
   *     连 `dir | findstr xxx` 都跑不了。
   *   · 默认 execMode='all'，不再因为白名单为空而拒绝一切。
   *   · 每条都记审计（命令全文、退出码、耗时），出问题能回溯。
   */
  async exec({ command, cwd, timeoutMs = 60000 } = {}) {
    if (!command || typeof command !== 'string') throw new Error('缺少 command');

    // 白名单模式才检查；默认 'all' 直接放行
    if (CONFIG.execMode === 'whitelist') {
      const allow = (CONFIG.allowExec || []).map((x) => x.replace(/\.exe$/i, '').toLowerCase());
      if (allow.length === 0) throw new Error('execMode 是 whitelist 但 allowExec 为空');
      const bin = command.trim().split(/\s+/)[0].replace(/^"|"$/g, '').replace(/\.exe$/i, '').toLowerCase();
      // 兼容 `C:\path\to\node.exe` 这种绝对路径
      const base = bin.split(/[\\/]/).pop();
      if (!allow.includes(bin) && !allow.includes(base)) {
        throw new Error(`命令不在白名单：${base}（允许：${allow.join(', ')}）`);
      }
    }

    const started = Date.now();
    const result = await new Promise((resolve) => {
      const win = IS_WIN;
      const file = win ? 'cmd.exe' : 'sh';
      // ⚠ Windows 上 `cmd /c` 有时会卡在「等标准输入」——尤其是命令里
      // 有需要确认的程序，或者 stdout 编码不对导致管道阻塞。
      // 加 `/q`（不回显）+ 显式把 stdin 关掉（stdio ignore）能避免。
      // 实测：不加这两条时，经中继的 exec 请求 25 秒也不回。
      // Windows 的 cmd 对首尾引号有特殊处理：`cmd /c "start http://x"` 会把
      // 引号一起交给被启动的程序，浏览器就收到一个带引号的 URL。
      // 统一剥掉最外层成对的引号。
      let cmdText = command;
      if (win && cmdText.length > 1 && cmdText.startsWith('"') && cmdText.endsWith('"')) {
        cmdText = cmdText.slice(1, -1);
      }
      // 中文输出同理：先 chcp 65001 再跑，否则 GBK 输出会被当 UTF-8 解成乱码
      if (win) cmdText = 'chcp 65001 >nul 2>&1 & ' + cmdText;
      const args = win ? ['/d', '/q', '/s', '/c', cmdText] : ['-c', cmdText];
      execFile(file, args, {
        cwd: cwd ? safePath(cwd) : os.homedir(),
        timeout: Math.min(Number(timeoutMs) || 60000, 300000),
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        // stdin 必须是 ignore：默认是 pipe 且从不关闭，
        // 任何「读一行」的程序（more、pause、某些 CLI）都会永远等下去，
        // 表现为请求超时。这一条是 exec 卡住的主因。
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(win ? { PYTHONIOENCODING: 'utf-8' } : {}) },
      }, (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: typeof err?.code === 'number' ? err.code : (err ? 1 : 0),
          stdout: String(stdout || '').slice(0, 400000),
          stderr: stripClixml(String(stderr || '')).slice(0, 40000),
          ms: Date.now() - started,
        });
      });
    });

    audit({ kind: 'exec', command: command.slice(0, 500), ok: result.ok, code: result.code, ms: result.ms });
    return result;
  },

  /**
   * 直接跑 PowerShell 脚本。最灵活的一条路：WMI、注册表、COM、.NET 全能用。
   *
   * 为什么单独开这个而不让用户塞进 exec：exec 走 cmd，引号和转义容易打架；
   * 这里用 -EncodedCommand（UTF-16LE base64），任何字符都不会被解释。
   */
  /**
   * 批量跑命令。为「效率」而存在：
   * 手机经中继访问，一次往返几百毫秒；要跑 10 条命令时逐条发很慢。
   *
   * @param commands [{ command, cwd?, stopOnError? }]
   * 顺序执行（并行会让输出混杂，反而更难用）。
   */
  async batch({ commands = [], cwd = null } = {}) {
    if (!Array.isArray(commands) || commands.length === 0) throw new Error('缺少 commands');
    if (commands.length > 30) throw new Error('一次最多 30 条');
    const results = [];
    for (const item of commands) {
      const cmd = typeof item === 'string' ? item : item?.command;
      if (!cmd) { results.push({ command: '', ok: false, error: '空命令' }); continue; }
      try {
        const r = await CAPS.exec({ command: cmd, cwd: item?.cwd ?? cwd, timeoutMs: item?.timeoutMs });
        results.push({ command: cmd, ...r });
        if (!r.ok && item?.stopOnError) break;
      } catch (e) {
        results.push({ command: cmd, ok: false, error: String(e?.message || e) });
        if (item?.stopOnError) break;
      }
    }
    return { ok: results.every((r) => r.ok), count: results.length, results };
  },

  /**
   * 在**电脑上**下载文件。手机只下命令，不传数据。
   *
   * 关键设计：**立刻返回，不等待下载完成**。
   * 之前写成同步等待，200MB 的安装包要下几分钟，那个 HTTP 请求就会
   * 一直挂着，最后被中继/客户端超时掐断——它看起来像「网络不行」，
   * 实际是我们的接口设计错了。
   *
   * 现在：启动后台下载 → 立刻返回 jobId → agent 过几秒查 /download/status。
   * 下载本身完全由电脑完成（电脑有自己的网络，不经过手机）。
   */
  async download({ url, path: p = null } = {}) {
    if (!url || typeof url !== 'string') throw new Error('缺少 url');
    const name = p || path.join(os.homedir(), 'Downloads',
      (url.split('/').pop() || 'download.bin').split('?')[0]);
    const dest = safePath(name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    const jobId = 'dl' + Date.now().toString(36);
    downloadJobs.set(jobId, { id: jobId, url: url.slice(0, 300), path: dest,
      status: 'running', startedAt: Date.now(), bytes: 0, error: null });

    // 后台跑，不 await
    (async () => {
      const job = downloadJobs.get(jobId);
      try {
        if (IS_WIN) {
          // BITS：断点续传、后台、系统级。比 Invoke-WebRequest 稳。
          // 很多下载站（含 qqdl.gtimg.cn）会拒掉没有 UA 的请求，直接 403。
          // BITS 不支持自定义 UA，改用 Invoke-WebRequest。
          const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
            + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
          const ps = `$ProgressPreference='SilentlyContinue';`
            + `$ErrorActionPreference='Stop';`
            + `Invoke-WebRequest -Uri '${url.replace(/'/g, "''")}' `
            + `-OutFile '${dest.replace(/'/g, "''")}' `
            + `-UserAgent '${ua}' -UseBasicParsing -MaximumRedirection 5`;
          await new Promise((resolve, reject) => {
            execFile('powershell.exe',
              ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-OutputFormat','Text',
               '-EncodedCommand', Buffer.from(ps,'utf16le').toString('base64')],
              { timeout: 1800000, windowsHide: true, maxBuffer: 1024*1024 },
              (err, so, se) => err ? reject(new Error(String(se||err.message).slice(0,300))) : resolve());
          });
        } else {
          await new Promise((resolve, reject) => {
            execFile('curl', ['-sSL', '-o', dest, url], { timeout: 1800000 },
              (err) => err ? reject(err) : resolve());
          });
        }
        job.status = 'done';
        job.bytes = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
        job.finishedAt = Date.now();
        audit({ kind: 'download', url: job.url, path: dest, size: job.bytes, ok: true });
      } catch (e) {
        job.status = 'failed';
        job.error = String(e?.message || e).slice(0, 300);
        job.finishedAt = Date.now();
        audit({ kind: 'download', url: job.url, path: dest, ok: false, error: job.error });
      }
    })();

    return { ok: true, jobId, status: 'running', path: dest,
             hint: '下载在电脑上进行，用 /download/status?jobId=xxx 查进度' };
  },

  /** 查下载进度。 */
  /**
   * 通用「等到某件事发生」原语。
   *
   * 为什么必须有它：模型没有等待能力时，只能 `sleep 60; 查一下; sleep 20; 再查`，
   * 真机日志里同一件事猜了 60/20/75 秒三次。有了 wait，一次请求就能
   * 「阻塞到条件成立或超时」，模型不需要猜时间。
   *
   * kind：
   *   file_exists  target=路径           文件出现即返回
   *   file_stable  target=路径           文件大小连续两次不变（下载完）
   *   file_size    target=路径 min=字节   文件达到指定大小
   *   process_gone target=进程名或PID     进程退出
   *   process_alive target=进程名或PID    进程出现
   *   custom       target=PowerShell 表达式，返回 $true 即成立
   *
   * 返回 { ok, met, waitedMs, detail }。met=false 表示等到超时还没成立——
   * 这时候模型该改方案，而不是继续等。
   */
  async wait({ kind, target, min = 0, timeoutMs = 110000, intervalMs = 1000 } = {}) {
    const KINDS = ['file_exists', 'file_stable', 'file_size',
                   'process_gone', 'process_alive', 'custom'];
    if (!KINDS.includes(kind)) throw new Error(`kind 必须是 ${KINDS.join('/')}`);
    if (!target) throw new Error('缺少 target');

    // 单次最长 110 秒：中继超时是 120 秒，留 10 秒余量。
    // 更长的等待应该分多次调用——每次都会带回现场，比盲等一小时强。
    const budget = Math.min(Number(timeoutMs) || 110000, 110000);
    const interval = Math.max(200, Math.min(Number(intervalMs) || 1000, 10000));
    const started = Date.now();

    let lastSize = -1;
    const probe = async () => {
      if (kind === 'custom') {
        const r = await this.ps({ script: `if (${target}) { 'YES' } else { 'NO' }`, timeoutMs: 15000 });
        return { met: String(r.stdout || '').includes('YES'), detail: String(r.stdout || '').trim() };
      }
      if (kind === 'process_gone' || kind === 'process_alive') {
        const q = /^\d+$/.test(String(target))
          ? `Get-Process -Id ${target} -ErrorAction SilentlyContinue`
          : `Get-Process -Name '${String(target).replace(/\.exe$/i,'')}' -ErrorAction SilentlyContinue`;
        const r = await this.ps({ script: `if (${q}) { 'YES' } else { 'NO' }`, timeoutMs: 15000 });
        const alive = String(r.stdout || '').includes('YES');
        return { met: kind === 'process_gone' ? !alive : alive, detail: alive ? 'running' : 'not running' };
      }
      // 文件类
      const abs = safePath(target);
      if (!fs.existsSync(abs)) {
        lastSize = -1;
        return { met: kind === 'process_gone', detail: 'missing' };
      }
      const st = fs.statSync(abs);
      if (kind === 'file_exists') return { met: true, detail: `${st.size} bytes` };
      if (kind === 'file_size') return { met: st.size >= Number(min), detail: `${st.size}/${min}` };
      // file_stable：两次间隔内大小不变，且不为 0
      const same = st.size === lastSize && st.size > 0;
      lastSize = st.size;
      return { met: same, detail: `${st.size} bytes` };
    };

    let detail = '';
    while (Date.now() - started < budget) {
      try {
        const r = await probe();
        detail = r.detail;
        if (r.met) return { ok: true, met: true, waitedMs: Date.now() - started, detail };
      } catch (e) { detail = String(e.message || e); }
      await new Promise((r) => setTimeout(r, interval));
    }
    return { ok: true, met: false, waitedMs: Date.now() - started, detail };
  },

  async downloadStatus({ jobId } = {}) {
    const job = downloadJobs.get(String(jobId || ''));
    if (!job) throw new Error('没有这个任务：' + jobId);
    // 运行中顺便报一下当前文件大小（BITS 是边写边增长）
    if (job.status === 'running' && fs.existsSync(job.path)) {
      try { job.bytes = fs.statSync(job.path).size; } catch {}
    }
    return job;
  },

  /** 列出所有下载任务。 */
  async downloads() {
    return { count: downloadJobs.size, jobs: [...downloadJobs.values()].slice(-20) };
  },

  async ps({ script, timeoutMs = 120000 } = {}) {
    if (!script || typeof script !== 'string') throw new Error('缺少 script');
    const ps = IS_WIN ? 'powershell.exe' : 'pwsh';
    // ⚠ 中文乱码的根因：Windows PowerShell 默认用系统代码页（中文机是 GBK/936）
    // 输出到 stdout，而 Node 按 UTF-8 解码 —— 于是「确定」变成「ȷ��」。
    // 在脚本最前面强制切到 UTF-8，一劳永逸。
    // 同时把输入输出编码都设好，避免 UI Automation 读出来的中文也是乱的。
    const header = IS_WIN
      ? "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;"
        + "$OutputEncoding=[System.Text.Encoding]::UTF8;"
        + "$PSDefaultParameterValues['*:Encoding']='utf8';"
      : "";
    // -EncodedCommand 避免所有引号/换行问题（UTF-16LE base64，与系统代码页无关）
    const encoded = Buffer.from(header + script, 'utf16le').toString('base64');
    const started = Date.now();
    const result = await new Promise((resolve) => {
      execFile(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-OutputFormat', 'Text', '-EncodedCommand', encoded], {
        timeout: Math.min(Number(timeoutMs) || 120000, 300000),
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      }, (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: typeof err?.code === 'number' ? err.code : (err ? 1 : 0),
          stdout: String(stdout || '').slice(0, 400000),
          stderr: stripClixml(String(stderr || '')).slice(0, 40000),
          ms: Date.now() - started,
        });
      });
    });
    audit({ kind: 'ps', command: script.slice(0, 300), ok: result.ok, code: result.code, ms: result.ms });
    return result;
  },
};

// ── HTTP ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { json(res, 204, {}); return; }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const route = url.pathname.replace(/^\/+/, '');

    // 健康检查不需要令牌：手机端用它判断「这个 IP 上是不是我们」。
    if (route === 'health') {
      json(res, 200, { ok: true, service: 'sigma-win', name: CONFIG.name, version: 1 });
      return;
    }

    // 令牌可以放 Header，也可以放查询串 `?token=`。
    // 后者是为了能在浏览器里直接排查（浏览器没法设 Header）——
    // 局域网/中继都是明文 HTTP，多一个入口不会降低多少安全性，
    // 但排障时省掉一大圈。
    let auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!auth) auth = url.searchParams.get('token') || '';
    if (!tokenOk(auth)) { json(res, 401, { ok: false, error: '令牌不对' }); return; }

    if (route === 'info') { json(res, 200, { ok: true, data: await CAPS.info() }); return; }

    // 审计日志：手机端可直接看「刚才电脑上做了什么」
    if (route === 'audit') {
      const n = Math.min(Number(url.searchParams.get('n')) || 50, 500);
      const lines = auditRing.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return l; } });
      json(res, 200, { ok: true, data: { count: lines.length, entries: lines } });
      return;
    }

    // 能力清单：让 agent 知道这台电脑能做什么
    if (route === 'caps') {
      json(res, 200, { ok: true, data: {
        exec: true, execMode: CONFIG.execMode,
        // 把权限范围说清楚：agent 之前以为只能读用户目录，
        // 于是用户说「要所有权限」时它回答「保持现状」，完全拧着来。
        roots: (CONFIG.roots || []).length === 0 ? 'ALL_DRIVES' : (CONFIG.roots || []),
        powershell: true, batch: true,
        input: ['move', 'click', 'dblclick', 'down', 'up', 'scroll', 'type',
                'key', 'keydown', 'keyup', 'release_all', 'screenshot', 'foreground', 'focus'],
        safety: ['watchdog_30s', 'release_all', 'expect_hwnd_guard'],
        concurrency: 'dual-lock (input / read)',
        dpiAware: IS_WIN,
        screen: ['stream', 'single'],
        files: ['list', 'read', 'write'],
      } });
      return;
    }

    // 鼠标键盘：GET 也能调（方便浏览器里直接试），参数走查询串
    if (route === 'input' && req.method === 'GET') {
      const q = Object.fromEntries(url.searchParams.entries());
      json(res, 200, { ok: true, data: await CAPS.input(q) });
      return;
    }

    // ── MJPEG 流 ──
    // 边界不用随机串：固定值即可，因为我们每帧都自带 Content-Length，
    // 客户端按长度读，不靠边界切分。
    if (route === 'screen') {
      try {
        ensureScreen();
      } catch (e) {
        json(res, 503, { ok: false, error: String(e.message) });
        return;
      }
      res.writeHead(200, {
        'content-type': 'multipart/x-mixed-replace; boundary=frame',
        'cache-control': 'no-store, no-cache, must-revalidate',
        'access-control-allow-origin': '*',
      });

      // ⚠ 必须立刻写点东西，否则 iOS 的 URLSession 会一直等第一块数据，
      // 15 秒后抛 -1001（真机日志实测：收到 200 响应头，但 didReceive data
      // 一次都没被调用）。先写占位帧拿到「响应头 + 首字节」，
      // 真正的画面 1-2 秒后跟上。
      screenClients.add(res);
      const first = screenFrame || PLACEHOLDER_JPEG;
      res.write(first, () => {});

      // 如果采集还没起来，主动催一次，并把第一帧补发
      if (!screenFrame) {
        const timer = setTimeout(() => {
          if (screenFrame && !res.writableEnded) {
            try { res.write(screenFrame); } catch { /* 已断 */ }
          }
        }, 300);
        timer.unref && timer.unref();
      }
      req.on('close', () => { screenClients.delete(res); stopScreenIfIdle(); });
      return;
    }

    // 单帧快照：App 里做「点一下看一眼」时用，不需要开流
    if (route === 'screen/one') {
      try {
        ensureScreen();
      } catch (e) {
        json(res, 503, { ok: false, error: String(e.message) });
        return;
      }
      const deadline = Date.now() + 5000;
      while (!screenFrame && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 80));
      }
      if (!screenFrame) { json(res, 504, { ok: false, error: screenErr || '抓不到画面（可能锁屏了）' }); return; }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': screenFrame.length,
        'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(screenFrame);
      return;
    }

    if (route === 'screen/meta') {
      json(res, 200, { ok: true, data: { streaming: !!screenProc, viewers: screenClients.size,
        info: screenInfo, error: screenErr } });
      return;
    }

    if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只支持 POST' }); return; }

    const body = await readBody(req);
    const fn = CAPS[route];
    if (typeof fn !== 'function') { json(res, 404, { ok: false, error: `没有这个能力：${route}` }); return; }

    const data = await fn(body);
    json(res, 200, { ok: true, data });
  } catch (error) {
    json(res, 400, { ok: false, error: String(error?.message || error) });
  }
});

server.on('error', (e) => {
  console.error('');
  if (e.code === 'EADDRINUSE') {
    // 用户开了两个客户端是最常见的启动失败。说清楚怎么处理，
    // 别只丢一个 EADDRINUSE 给非技术用户。
    console.error(`  端口 ${PORT} 已被占用：可能已经有一个客户端在运行了。`);
    console.error('  关掉另一个窗口，或设环境变量 SIGMA_WIN_PORT 换端口。');
  } else {
    console.error(`  启动失败：${e.message}`);
  }
  crashLog(e);
  keepWindow('启动失败');
});

server.listen(PORT, '0.0.0.0', () => {
  const addrs = lanAddresses();
  const pair = CONFIG.token.slice(0, 6).toUpperCase();

  console.log('');
  console.log('  Sigma Windows 客户端已启动');
  console.log('  ─────────────────────────────────────────');
  console.log(`  名称    ${CONFIG.name}`);
  console.log(`  端口    ${PORT}`);
  for (const a of addrs) console.log(`  地址    http://${a}:${PORT}`);
  if (addrs.length === 0) console.log('  地址    (没检测到局域网地址，检查网络)');
  // 这里的 pair 是令牌前 6 位，只用来让用户核对「手机上是同一个令牌」，
  // 真正的跨网配对码在下面单独打印。
  console.log(`  校验码  ${pair}`);
  console.log(`  令牌    ${CONFIG.token}`);
  console.log('');
  console.log(`  配置文件 ${CONFIG_PATH}`);
  console.log(`  命令执行 ${(CONFIG.allowExec || []).length ? '已启用：' + CONFIG.allowExec.join(', ') : '未启用（只读文件、查信息）'}`);
  console.log('');
  if (CONFIG.relay) {
    console.log(`  配对码  ${CONFIG.code}   ← 不在同一网络时，手机端填这个`);
    console.log(`  中继    ${CONFIG.relay}`);
  }
  console.log('');
  console.log('  手机端：Sigma → 设置 → 远程电脑 → 填上面的地址和令牌');
  console.log('         不在同一 Wi-Fi 时，改填「配对码」');
  console.log('  按 Ctrl+C 停止');
  console.log('');

  // 本地服务起来之后再连中继：隧道的字节要转发到 PORT，
  // 早连会让头几个请求打空。
  if (CONFIG.relay) connectRelay();
  // 首次运行提示：这两个弹窗是客户最常卡住的地方，
  // 直接印在窗口里，比让他翻 README 有用。
  if (!CONFIG.seenTip) {
    console.log('  ┌─ 首次运行，请留意两件事 ─────────────────────┐');
    console.log('  │ 1. 如果弹出「Windows 防火墙」，请勾选          │');
    console.log('  │    「专用网络」并点「允许访问」，否则手机连不上 │');
    console.log('  │ 2. 手机和这台电脑要在同一个 Wi-Fi 下           │');
    console.log('  └───────────────────────────────────────────────┘');
    console.log('');
    CONFIG.seenTip = true;
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2), { mode: 0o600 }); } catch { /* 写不了就每次都提示 */ }
  }
});

// ── 局域网信标：手机不用手动输 IP ─────────────────────────────────────
// 用裸 UDP 广播，零依赖。手机端监听 8099 端口，收到就能列出可用电脑。
try {
  const beacons = [];
  const msg = Buffer.from(JSON.stringify({
    service: 'sigma-win',
    name: CONFIG.name,
    port: PORT,
    platform: process.platform,
  }));
  for (const a of lanAddresses()) {
    const sock = (await import('node:dgram')).createSocket({ type: 'udp4', reuseAddr: true });
    sock.bind(() => {
      sock.setBroadcast(true);
      const timer = setInterval(() => {
        // 广播到该网段的 .255；跨网段由 Tailscale 处理。
        const bcast = a.split('.').slice(0, 3).join('.') + '.255';
        try { sock.send(msg, 0, msg.length, BEACON_PORT, bcast); } catch { /* 网卡不支持广播 */ }
      }, 3000);
      timer.unref?.();
    });
    beacons.push(sock);
  }
} catch { /* 信标是可选的，失败不影响连接 */ }

process.on('SIGINT', () => { console.log('\n已停止'); process.exit(0); });
