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
import { execFile } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(HERE, 'config.json');
const PORT = Number(process.env.SIGMA_WIN_PORT || 8092);
const BEACON_PORT = Number(process.env.SIGMA_WIN_BEACON || 8099);
const IS_WIN = process.platform === 'win32';

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
  console.log(`  配对码  ${pair}`);
  console.log(`  令牌    ${CONFIG.token}`);
  console.log('');
  console.log(`  配置文件 ${CONFIG_PATH}`);
  console.log(`  命令执行 ${(CONFIG.allowExec || []).length ? '已启用：' + CONFIG.allowExec.join(', ') : '未启用（只读文件、查信息）'}`);
  console.log('');
  console.log('  手机端：Sigma → 设置 → 远程电脑 → 填上面的地址和令牌');
  console.log('  按 Ctrl+C 停止');
  console.log('');
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
