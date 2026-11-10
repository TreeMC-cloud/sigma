#!/usr/bin/env node
/**
 * win-pc —— 连用户自己的 Windows 电脑。
 *
 * 设计取舍：
 *   1. **配置存文件**（默认 `$DSH_IOS_DATA/win-pc.json`），不存记忆库。
 *      令牌是凭据，不该进会每轮注入的上下文。
 *   2. **只用 Node 内置模块**。这个脚本要在 iPhone 的引擎里跑，
 *      多引一个包就多一份装不上的风险。
 *   3. **超时短**（5s 连接 / 30s 请求）。局域网里慢到几十秒，
 *      基本就是不在同一网段，等下去只会让用户以为卡死。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import process from 'node:process';

const DATA = process.env.DSH_IOS_DATA || path.join(os.homedir(), '.ios');
const CFG = process.env.DSH_WIN_PC_CONFIG || path.join(DATA, 'win-pc.json');

function load() {
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { return null; }
}
function save(cfg) {
  fs.mkdirSync(path.dirname(CFG), { recursive: true });
  fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/** 统一的请求封装：带令牌、限时、错误说人话。 */
async function call(cfg, route, body) {
  const url = cfg.url.replace(/\/+$/, '') + '/' + route;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${cfg.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) {
      throw new Error(json.error || `HTTP ${res.status}`);
    }
    return json.data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('请求超时：电脑没响应，确认客户端还开着、且在同一网络');
    if (String(error.message).includes('fetch failed')) {
      throw new Error(`连不上 ${cfg.url}：可能不在同一 Wi-Fi，或 Windows 防火墙拦了`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 局域网广播扫描：客户端每 3 秒往 x.y.z.255:8099 发一次 JSON。 */
function scan(ms = 5000) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (buf, rinfo) => {
      try {
        const m = JSON.parse(buf.toString('utf8'));
        if (m.service !== 'sigma-win') return;
        found.set(`${rinfo.address}:${m.port}`, { ...m, address: rinfo.address });
      } catch { /* 不是我们的包 */ }
    });
    sock.on('error', () => {});
    sock.bind(8099, () => {
      try { sock.setBroadcast(true); } catch { /* 某些网卡不支持 */ }
    });
    setTimeout(() => {
      try { sock.close(); } catch { /* 已关 */ }
      resolve([...found.values()]);
    }, ms);
  });
}

function readStdin() {
  return new Promise((r) => {
    let s = '';
    process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', () => r(s.trim()));
    setTimeout(() => r(s.trim()), 500);
  });
}

const [cmd, ...rest] = process.argv.slice(2);
const arg = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const pos = rest.filter((x) => !x.startsWith('--'));

function need() {
  const cfg = load();
  if (!cfg?.url || !cfg?.token) {
    console.error('还没连过电脑。先运行：pc.mjs connect --url <地址> --token <令牌>');
    process.exit(2);
  }
  return cfg;
}

try {
  if (cmd === 'connect') {
    // 两种模式：--url 直连，--code 走中继
    const code = arg('--code');
    const relay = arg('--relay') || 'http://202.189.51.44:8791';
    let url = arg('--url');
    const token = arg('--token');
    if (code) url = relay.replace(/\/+$/, '') + '/c/' + String(code).toUpperCase();
    if (!url || !token) throw new Error('用法：connect --url <地址> --token <令牌>  或  connect --code <配对码> --token <令牌>');
    const cfg = { url: url.replace(/\/+$/, ''), token, connectedAt: Date.now() };
    // 先验证再存：存下一个连不上的地址，后面每次都要重来。
    const info = await call(cfg, 'info');
    save(cfg);
    console.log(`已连接：${info.name}（${info.platform} ${info.arch}，${info.cpus} 核 / ${info.memGB}GB）`);
  } else if (cmd === 'status') {
    const cfg = load();
    if (!cfg) { console.log('未连接'); process.exit(0); }
    console.log(`地址 ${cfg.url}`);
    console.log(`令牌 ${String(cfg.token).slice(0, 6)}…（其余已隐藏）`);
    try {
      const info = await call(cfg, 'info');
      console.log(`状态 在线 · ${info.name} · ${info.platform} ${info.arch} · ${info.cpus} 核 / ${info.memGB}GB`);
    } catch (e) { console.log(`状态 离线（${e.message}）`); }
  } else if (cmd === 'scan') {
    const list = await scan();
    if (list.length === 0) console.log('局域网里没找到客户端（确认它开着，且在同一个 Wi-Fi）');
    else for (const d of list) console.log(`http://${d.address}:${d.port}  ${d.name}  ${d.platform}`);
  } else if (cmd === 'info') {
    console.log(JSON.stringify(await call(need(), 'info'), null, 2));
  } else if (cmd === 'ls') {
    const p = pos[0] || '.';
    const d = await call(need(), 'list', { path: p });
    console.log(`${d.path}（${d.count} 项）`);
    for (const it of d.items) {
      console.log(`${it.dir ? 'DIR ' : '    '} ${String(it.size).padStart(10)}  ${it.name}`);
    }
  } else if (cmd === 'read') {
    const d = await call(need(), 'read', { path: pos[0] });
    console.log(d.truncated ? `（已截断，完整 ${d.size} 字节）` : `（${d.size} 字节）`);
    console.log(d.content);
  } else if (cmd === 'write') {
    const p = pos[0];
    let content = arg('--content');
    const from = arg('--from');
    if (from) content = fs.readFileSync(from, 'utf8');
    if (content === undefined) throw new Error('用法：write <路径> --content "内容" 或 --from <本地文件>');
    const d = await call(need(), 'write', { path: p, content });
    console.log(`已写入 ${d.path}（${d.bytes} 字节）`);
  } else if (cmd === 'run') {
    // 执行任意命令（走 shell，支持管道/重定向）
    const command = pos.join(' ') || arg('--command');
    if (!command) throw new Error('用法：run "命令"');
    const d = await call(need(), 'exec', { command, timeoutMs: Number(arg('--timeout')) || 60000 });
    if (d.stdout) process.stdout.write(d.stdout);
    if (d.stderr) process.stderr.write(d.stderr);
    console.error(`（${d.ok ? 'ok' : '失败'} · 退出码 ${d.code} · ${d.ms}ms）`);
    if (!d.ok) process.exit(1);
  } else if (cmd === 'ps') {
    // 直接跑 PowerShell 脚本：能碰 WMI / 注册表 / COM / .NET
    const script = pos.join(' ') || arg('--script') || (await readStdin());
    if (!script) throw new Error('用法：ps "PowerShell 脚本" 或 echo "脚本" | pc.mjs ps');
    const d = await call(need(), 'ps', { script });
    if (d.stdout) process.stdout.write(d.stdout);
    if (d.stderr) process.stderr.write(d.stderr);
    if (!d.ok) process.exit(1);
  } else if (cmd === 'batch') {
    const cmds = pos.length ? pos : (arg('--commands') || '').split('|').filter(Boolean);
    if (!cmds.length) throw new Error('用法：batch "命令1" "命令2" ...');
    const d = await call(need(), 'batch', { commands: cmds });
    for (const r of d.results) {
      console.log(`${r.ok ? '✓' : '✗'} ${r.command}`);
      if (r.stdout) console.log(r.stdout.trimEnd());
      if (r.stderr) console.error(r.stderr.trimEnd());
    }
    if (!d.ok) process.exit(1);
  } else if (cmd === 'mouse') {
    // mouse move 800 600 / mouse click left / mouse scroll -3
    const sub = pos[0];
    const args = { action: sub };
    if (sub === 'move' || sub === 'click' || sub === 'dblclick') {
      args.x = Number(pos[1]);
      args.y = Number(pos[2]);
    }
    if (sub === 'click' && pos[3]) args.button = pos[3];
    if (sub === 'scroll') args.delta = Number(pos[1]);
    const d = await call(need(), 'input', args);
    console.log(JSON.stringify(d));
  } else if (cmd === 'key') {
    // key "CTRL+V"
    if (!pos[0]) throw new Error('用法：key "CTRL+V"');
    const d = await call(need(), 'input', { action: 'key', keys: pos[0] });
    console.log(JSON.stringify(d));
  } else if (cmd === 'type') {
    const text = pos.join(' ');
    if (!text) throw new Error('用法：type "要打的字"');
    const d = await call(need(), 'input', { action: 'type', text });
    console.log(JSON.stringify(d));
  } else if (cmd === 'download') {
    const url = pos[0];
    if (!url) throw new Error('用法：download <url> [保存路径]');
    const d = await call(need(), 'download', { url, path: pos[1] || null });
    // 后台任务：立刻返回 jobId，不再谎报「已下载」
    console.log(`已开始下载 → job ${d.jobId}`);
    console.log(`保存到 ${d.path}`);
    console.log(`查进度：pc.mjs download-status ${d.jobId}`);
  } else if (cmd === 'download-status') {
    const jobId = pos[0];
    if (!jobId) throw new Error('用法：download-status <jobId>');
    const d = await call(need(), 'download-status', { jobId });
    const mb = (d.bytes/1048576).toFixed(1);
    console.log(`${d.status} · ${mb} MB${d.error ? ' · ' + d.error : ''}`);
    if (d.status === 'done') console.log(`已保存：${d.path}`);
  } else if (cmd === 'downloads') {
    const d = await call(need(), 'downloads', {});
    for (const j of d.jobs) console.log(`${j.id} ${j.status} ${(j.bytes/1048576).toFixed(1)}MB ${j.path}`);
  } else if (cmd === 'fetch') {
    // 把电脑上的文件（截图、日志、产物）取回本地，存到 --out 指定的路径。
    // 之前没有这个命令，模型只能用 read 硬拉二进制，
    // 结果 151KB 的 PNG 被截断、还会把 $env:TEMP 当成字面量。
    const remote = pos[0];
    const out = arg('--out');
    if (!remote || !out) throw new Error('用法：fetch <远端路径> --out <本地路径>');
    const d = await call(need(), 'read', { path: remote, maxBytes: 8 * 1024 * 1024, base64: true });
    const buf = Buffer.from(d.content || '', 'base64');
    fs.writeFileSync(out, buf);
    console.log(`已取回 ${remote}`);
    console.log(`→ ${out}（${(buf.length/1024).toFixed(0)} KB${d.truncated ? '，已截断' : ''}）`);
  } else if (cmd === 'push') {
    // 把手机上的文件（用户发来的附件、agent 生成的产物）传到电脑指定位置。
    // 配合 pull 构成双向文件通道：pull = 电脑→手机，push = 手机→电脑。
    const local = pos[0];
    const remote = pos[1] || arg('--to');
    if (!local || !remote) throw new Error('用法：push <本地路径> <电脑上的目标路径>');
    if (!fs.existsSync(local)) throw new Error(`本地文件不存在：${local}`);

    const buf = fs.readFileSync(local);
    if (buf.length > 64 * 1024 * 1024) throw new Error(`文件太大（${(buf.length/1048576).toFixed(1)}MB，上限 64MB）`);

    const d = await call(need(), 'write', {
      path: remote,
      content: buf.toString('base64'),
      encoding: 'base64',
    });
    console.log(`已上传 ${path.basename(local)} → ${d.path}（${(d.bytes/1024).toFixed(0)} KB）`);
  } else if (cmd === 'pull') {
    // 把电脑上的文件拉到手机上，落到 App 的附件目录，然后弹预览。
    // 这是「让电脑做点东西给我」的最后一公里：做完 → 取回 → 直接看到。
    const remote = pos[0];
    if (!remote) throw new Error('用法：pull <电脑上的路径> [本地文件名]');
    const name = pos[1] || path.basename(String(remote).replace(/\\/g, '/'));
    const outDir = process.env.DSH_ATTACH_DIR || '/var/minis/attachments';
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, name);

    const d = await call(need(), 'read', { path: remote, maxBytes: 64 * 1024 * 1024, base64: true });
    const buf = Buffer.from(d.content || '', 'base64');
    if (!buf.length) throw new Error('取回的文件是空的（路径对不对？）');
    fs.writeFileSync(out, buf);
    console.log(`已取回 ${remote}`);
    console.log(`→ ${out}（${(buf.length/1048576).toFixed(2)} MB${d.truncated ? '，已截断' : ''}）`);
    console.log(`minis://attachments/${name}`);
  } else if (cmd === 'psfile') {
    // 从本地 .ps1 文件读脚本发过去执行。
    //
    // 为什么需要它：在 bash 里写 `pc.mjs ps "$b=...; $x.Read(...)"` 时，
    // 反引号、$、引号要穿三层（bash → JSON → cmd → PowerShell），
    // 真机日志里模型反复踩这个坑，写出来的命令变量名被吃掉，
    // 拿到 `header=` 空值还不知道为什么。
    // 写成文件再传，转义层数降到零。
    const f = pos[0];
    if (!f) throw new Error('用法：psfile <本地.ps1路径>');
    if (!fs.existsSync(f)) throw new Error(`本地脚本不存在：${f}`);
    const script = fs.readFileSync(f, 'utf8');
    const d = await call(need(), 'ps', { script, timeoutMs: Number(arg('--timeout') || 180000) });
    if (d.stdout) process.stdout.write(d.stdout);
    if (d.stderr) process.stderr.write(d.stderr);
    if (!d.ok) process.exitCode = 1;
  } else if (cmd === 'shot' || cmd === 'screenshot') {
    // 截一张全屏图，返回路径 + 尺寸 + 字节数。
    // 模型不支持图像输入，所以「看图」这条路走不通——
    // 但尺寸和字节数能判断「界面变没变」，路径也能给用户看。
    const d = await call(need(), 'input', { action: 'screenshot', text: pos[0] || '' });
    console.log(`已截图 ${d.path}`);
    console.log(`${d.width}x${d.height} · ${(d.bytes/1024).toFixed(0)} KB`);
  } else if (cmd === 'audit') {
    const cfg = need();
    const url = cfg.url.replace(/\/+$/, '') + '/audit?n=' + (arg('--n') || 20);
    const res = await fetch(url, { headers: { authorization: `Bearer ${cfg.token}` } });
    const j = await res.json();
    for (const e of (j.data?.entries || []).reverse()) {
      console.log(`${e.at} ${e.kind} ${e.command || e.action || ''} ${e.ok === false ? '✗' : '✓'}`);
    }
  } else if (cmd === 'caps') {
    const cfg = need();
    const res = await fetch(cfg.url.replace(/\/+$/, '') + '/caps', { headers: { authorization: `Bearer ${cfg.token}` } });
    console.log(JSON.stringify(await res.json(), null, 2));
  } else if (cmd === 'exec') {
    const command = pos.join(' ') || arg('--command');
    if (!command) throw new Error('用法：exec "命令"');
    const d = await call(need(), 'exec', { command });
    if (d.stdout) process.stdout.write(d.stdout);
    if (d.stderr) process.stderr.write(d.stderr);
    if (!d.ok) { console.error(`（退出码 ${d.code}）`); process.exit(1); }
  } else {
    console.log(`用法：
  pc.mjs connect --url <地址> --token <令牌>   连接并验证
  pc.mjs status                                看是否连着、在不在线
  pc.mjs scan                                  在局域网里找客户端
  pc.mjs info                                  系统信息
  pc.mjs ls <路径>                             列目录
  pc.mjs read <路径>                           读文件
  pc.mjs write <路径> --content "..."          写文件
  pc.mjs exec "<命令>"                         跑白名单内的命令`);
    process.exit(cmd ? 1 : 0);
  }
} catch (error) {
  console.error(String(error?.message || error));
  process.exit(1);
}
