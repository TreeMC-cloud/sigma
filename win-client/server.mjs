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
    allowExec: [],
    // 允许访问的根目录；默认是用户主目录。留空 = 不限制（不推荐）。
    roots: [os.homedir()],
    // 中继：跨网络时用。空字符串 = 只用局域网。
    relay: DEFAULT_RELAY,
    // 配对码：固定下来便于「记住的设备」直接连；首次随机生成。
    code: Array.from({ length: 6 }, () =>
      'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[crypto.randomInt(32)]).join(''),
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return cfg;
}

const CONFIG = loadConfig();

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
function safePath(p) {
  // 先展开 ~：客户和模型都会写 `~\Documents`，不展开会变成「主目录下名叫 ~ 的目录」，
  // 看起来成功、实际写到别处——这种错最难查。
  let raw = String(p || '.').trim();
  if (raw === '~') raw = os.homedir();
  else if (raw.startsWith('~/') || raw.startsWith('~\\')) raw = path.join(os.homedir(), raw.slice(2));
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(os.homedir(), raw);
  const roots = (CONFIG.roots || []).map((r) => path.resolve(r));
  if (roots.length === 0) return abs;
  const ok = roots.some((r) => abs === r || abs.startsWith(r + path.sep));
  if (!ok) throw new Error(`路径不在允许范围内：${abs}`);
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

// ── 中继隧道 ──────────────────────────────────────────────────────────
//
// 目的：电脑没有公网 IP 时，手机在外网也能连。
//
// 做法：主动出站连到中继（WebSocket），手机也连同一个中继，
// 中继按配对码把两条连接对接。出站连接能穿任何 NAT，所以两边都不需要
// 公网地址。
//
// 关键设计：进来的字节被当成**原始 TCP 流**喂给本机的 HTTP 服务。
// 不解码、不重组——中继只做管道，这样分块传输、大文件、MJPEG 流
// 全都能原样穿过，不需要为每种情况写特殊处理。

let relayWS = null;
let relayState = 'off';   // off | connecting | online | error
let relayError = null;

function connectRelay() {
  const url = CONFIG.relay;
  if (!url || relayState === 'connecting' || relayState === 'online') return;
  if (typeof WebSocket === 'undefined') {
    relayState = 'error';
    relayError = '这个 Node 版本没有内置 WebSocket（需要 21+）';
    console.log(`  中继    不可用：${relayError}`);
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
    // ⚠ 关键：手机可能把 HTTP 请求当**文本帧**发过来（WebSocket 的 send(string)），
    // 也可能当二进制帧。握手完成后所有文本都要当数据，不能只认二进制——
    // 之前只处理二进制，文本帧进了 JSON.parse 失败就被静默丢掉，
    // 表现是「配对了但一个字节都过不来」。
    if (relayState === 'online' && typeof evt.data === 'string' && !evt.data.startsWith('{')) {
      handleTunnelChunk(Buffer.from(evt.data, 'utf8'));
      return;
    }
    if (typeof evt.data === 'string') {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'registered') {
          relayState = 'online';
          console.log(`  中继    已上线（配对码 ${CONFIG.code}）`);
        }
        if (msg.type === 'paired') {
          console.log('\n  ✓ 手机已通过中继连上\n');
          closeTunnel();
          openTunnel();
        }
        if (msg.type === 'error') { relayState = 'error'; relayError = msg.message; }
      } catch { /* 非 JSON 文本：当数据丢弃 */ }
      return;
    }
    handleTunnelChunk(Buffer.from(evt.data));
  });

  ws.addEventListener('close', () => {
    relayWS = null;
    closeTunnel();
    if (relayState === 'online' || relayState === 'connecting') {
      relayState = 'off';
      // 断了就重连：客户可能长时间开着，网络抖一下就永久失联太糟
      setTimeout(connectRelay, 5000);
    }
  });

  ws.addEventListener('error', (e) => {
    relayState = 'error';
    relayError = (e && e.message) || '连不上中继（网络被拦？）';
    // 打出来：用户看不到的话，出问题只能干猜
    console.log(`  中继    连接失败：${relayError}`);
  });

  relayWS = ws;
}

/**
 * 隧道 → 本机 HTTP 的一条长连接。
 *
 * 之前每个数据块都新建一条 TCP，把块当成「完整请求」——错在两点：
 *   1. 一个 HTTP 请求可能被拆成多个 WebSocket 消息
 *   2. 一次 TCP 只能处理一个请求，客户端复用连接就废了
 *
 * 现在：配对成功后开一条 TCP，双向对接，来多少转多少。
 * 不解析 HTTP，所以分块、长连接、MJPEG 流全都自然可用。
 */
let tunnelSock = null;

function openTunnel() {
  if (tunnelSock) return tunnelSock;
  tunnelSock = net.connect(PORT, '127.0.0.1');
  tunnelSock.setNoDelay(true);
  // 手机那头断了就关掉这条，下次配对重开
  tunnelSock.on('close', () => { tunnelSock = null; });
  tunnelSock.on('error', () => { tunnelSock = null; });
  tunnelSock.on('data', (d) => {
    if (process.env.SIGMA_TUNNEL_DEBUG) console.log(`  隧道    → ${d.length} 字节回传`);
    if (relayWS && relayWS.readyState === 1) {
      // 转成 ArrayBuffer 发：中继按二进制原样转发
      relayWS.send(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
    }
  });
  return tunnelSock;
}

function closeTunnel() {
  if (tunnelSock) { try { tunnelSock.destroy(); } catch { /* 已断 */ } tunnelSock = null; }
}

function handleTunnelChunk(buf) {
  const sock = openTunnel();
  if (!sock) { console.log('  隧道    没有连接，丢弃', buf.length, '字节'); return; }
  if (process.env.SIGMA_TUNNEL_DEBUG) {
    console.log(`  隧道    ← ${buf.length} 字节：${buf.subarray(0, 60).toString('utf8').replace(/\r\n/g, ' ')}`);
  }
  // 可能还没连上（connect 是异步的），排队等 ready
  if (sock.connecting) {
    sock.once('connect', () => { try { sock.write(buf); } catch { /* 已断 */ } });
  } else {
    try { sock.write(buf); } catch { /* 写失败，close 会兜 */ }
  }
}

function renderBanner() {
  // 由主流程统一打印，这里只更新状态
}

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
  const script = process.env.SIGMA_SCREEN_SCRIPT || path.join(HERE, 'screen.ps1');
  let scriptPath = script;
  if (!fs.existsSync(script)) {
    // 退一步：把内置副本写到临时目录再用（PowerShell -File 需要真实路径）
    const tmp = path.join(os.tmpdir(), `sigma-screen-${process.pid}.ps1`);
    try {
      fs.writeFileSync(tmp, EMBEDDED_SCREEN_PS1, 'utf8');
      scriptPath = tmp;
    } catch {
      throw new Error('缺少 screen.ps1，且无法写入临时目录');
    }
  }


  // 参数顺序有讲究：
  //   Windows 的 powershell -File 后面**不能再跟任何 - 开头的开关**，否则它会把
  //   参数当成 powershell 自己的开关（实测报 `illegal option -N`，因为 -NoProfile
  //   被当成了脚本参数）。所以 -NoProfile / -ExecutionPolicy 必须放在 -File 前面。
  //   非 Windows（测试用）走 sh，参数是另一套。
  const args = process.env.SIGMA_SCREEN_SCRIPT
    ? [scriptPath]
    : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
       '-Fps', String(CONFIG.screenFps || 12),
       '-Quality', String(CONFIG.screenQuality || 55),
       '-Scale', String(CONFIG.screenScale || 0.5)];

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
          const [, w, h, fps] = line.split(' ');
          screenInfo = { w: Number(w), h: Number(h), fps: Number(fps) };
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
      execEnabled: (CONFIG.allowExec || []).length > 0,
      execAllowed: CONFIG.allowExec || [],
    };
  },

  async list({ path: p = '.' } = {}) {
    const abs = safePath(p);
    const items = fs.readdirSync(abs, { withFileTypes: true }).map((e) => {
      let size = 0;
      try { size = e.isFile() ? fs.statSync(path.join(abs, e.name)).size : 0; } catch { /* 权限不足 */ }
      return { name: e.name, dir: e.isDirectory(), size };
    });
    // 目录在前，再按名字排，便于人读。
    items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    return { path: abs, count: items.length, items: items.slice(0, 500) };
  },

  async read({ path: p, maxBytes = 256 * 1024 } = {}) {
    const abs = safePath(p);
    const stat = fs.statSync(abs);
    if (!stat.isFile()) throw new Error('不是文件');
    if (stat.size > maxBytes) {
      return { path: abs, size: stat.size, truncated: true, content: fs.readFileSync(abs).subarray(0, maxBytes).toString('utf8') };
    }
    return { path: abs, size: stat.size, truncated: false, content: fs.readFileSync(abs, 'utf8') };
  },

  async write({ path: p, content = '', encoding = 'utf8' } = {}) {
    const abs = safePath(p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, encoding);
    return { path: abs, bytes: Buffer.byteLength(content, encoding) };
  },

  /**
   * 跑命令。默认禁用，而且只认白名单里的可执行文件。
   *
   * 为什么不做「任意命令」：这是客户自己的电脑，一旦令牌泄露，
   * 任意执行等于把整台机器交出去。白名单让人能明确知道放出去了什么。
   */
  async exec({ command, cwd, timeoutMs = 30000 } = {}) {
    if (!command || typeof command !== 'string') throw new Error('缺少 command');
    const allow = CONFIG.allowExec || [];
    if (allow.length === 0) throw new Error('未启用命令执行：请在 config.json 的 allowExec 里加上允许的程序');
    // 只看第一个词，不解析管道/重定向——不做 shell，避免注入。
    const parts = command.trim().split(/\s+/);
    const bin = parts[0].replace(/\.exe$/i, '');
    if (!allow.map((x) => x.replace(/\.exe$/i, '')).includes(bin)) {
      throw new Error(`命令不在白名单：${bin}（允许：${allow.join(', ')}）`);
    }
    return await new Promise((resolve) => {
      execFile(parts[0], parts.slice(1), {
        cwd: cwd ? safePath(cwd) : undefined,
        timeout: Math.min(Number(timeoutMs) || 30000, 120000),
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      }, (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err?.code ?? 0,
          stdout: String(stdout || '').slice(0, 200000),
          stderr: String(stderr || '').slice(0, 20000),
        });
      });
    });
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

    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!tokenOk(auth)) { json(res, 401, { ok: false, error: '令牌不对' }); return; }

    if (route === 'info') { json(res, 200, { ok: true, data: await CAPS.info() }); return; }

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
        connection: 'close',
        'access-control-allow-origin': '*',
      });
      screenClients.add(res);
      // 新连接先给最后一帧，避免等 1/fps 秒才看到画面
      if (screenFrame) res.write(screenFrame, () => {});
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
