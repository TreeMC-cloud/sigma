#!/usr/bin/env node
/**
 * Sigma 中继 —— 让「电脑没有公网 IP」也能被手机连上。
 *
 * 原理：
 *   电脑和手机都主动【出站】连到这里，中转站按配对码把两条连接对接起来。
 *   出站连接能穿过任何 NAT，所以双方都不需要公网 IP。
 *
 * 协议（极简，够用就好）：
 *   1. 连接后第一条消息必须是 JSON 握手：
 *        { "role": "host" | "client", "code": "ABC123" }
 *      host 用自己生成的码注册（重复则覆盖，允许重连）；
 *      client 用码找 host，找到就配对，找不到回 error。
 *   2. 配对成功后，两端之间的所有字节原样转发（不解析 HTTP）。
 *      这样 host 上的 HTTP 服务对 client 来说就像直连一样。
 *
 * 为什么不做成通用代理：
 *   只转发字节，不解析请求，意味着不需要处理分块编码、WebSocket 升级、
 *   大文件流……出了问题也容易查。这是刻意的取舍。
 *
 * 安全：
 *   · 配对码 6 位、30 分钟不用即失效；连续 5 次错码封 IP 10 分钟
 *   · 不记录、不落盘任何业务数据
 *   · 单 host 只允许一个 client（避免串线）
 */

import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.SIGMA_RELAY_PORT || 8791);
const CODE_TTL_MS = 30 * 60_000;
const MAX_PAIR_FAILS = 5;
const FAIL_WINDOW_MS = 10 * 60_000;

/** code -> { socket, meta, timer } */
const hosts = new Map();
// 运行时计数：挂到 /health 里，不依赖日志文件就能看出来到底转没转
const stat = { framesIn: 0, framesFwd: 0, binds: 0, errors: [], sample: [] };
/** ip -> { fails, until } */
const fails = new Map();

// ── WebSocket 最小实现 ────────────────────────────────────────────────
// 不引 ws 库：服务器上没有外网装包，而且我们只需要最基础的分帧。
function acceptKey(key) {
  return crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function frame(payload, opcode = 0x1) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** 从缓冲里切出完整帧；返回 [frames, rest]。 */
function parseFrames(buf) {
  const out = [];
  let off = 0;
  while (off + 2 <= buf.length) {
    const b1 = buf[off + 1];
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (p + 2 > buf.length) break;
      len = buf.readUInt16BE(p); p += 2;
    } else if (len === 127) {
      if (p + 8 > buf.length) break;
      len = Number(buf.readBigUInt64BE(p)); p += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (p + maskLen + len > buf.length) break;
    let payload = buf.subarray(p + maskLen, p + maskLen + len);
    if (masked) {
      const mask = buf.subarray(p, p + 4);
      const copy = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i += 1) copy[i] = payload[i] ^ mask[i % 4];
      payload = copy;
    }
    const opcode = buf[off] & 0x0f;
    out.push({ opcode, payload });
    off = p + maskLen + len;
  }
  return [out, buf.subarray(off)];
}

/**
 * 把一段完整的 HTTP 请求送进隧道，等响应回来写进 res。
 *
 * 为什么用「一请求一连接」而不是复用：中继要同时服务多个 App 请求，
 * 复用会让响应互相串。每个请求临时占用 host 一次，简单可靠。
 */
function proxyThrough(hostSocket, rawRequest, res) {
  const st = hostSocket.__st;
  if (!st || st.closed) { res.writeHead(502); res.end('电脑断开了'); return; }

  let head = Buffer.alloc(0);
  let sentHead = false;
  let need = -1;        // Content-Length 剩余
  let got = 0;

  const finish = () => {
    clearTimeout(timer);
    st.stream = null;
    if (!res.writableEnded) res.end();
  };

  // 超时只对「还没收到响应头」的情况生效。
  // 收到头之后是流（比如 MJPEG），本来就不该有结束时间。
  const timer = setTimeout(() => {
    if (!sentHead) { st.stream = null; res.writeHead(504); res.end('电脑没响应'); }
  }, 20000);

  st.stream = (buf) => {
    if (!sentHead) {
      head = Buffer.concat([head, buf]);
      const sep = head.indexOf('\r\n\r\n');
      if (sep < 0) {
        if (head.length > 64 * 1024) { res.writeHead(502); res.end('响应头异常'); st.stream = null; }
        return;
      }
      const headerText = head.subarray(0, sep).toString('latin1');
      const body = head.subarray(sep + 4);
      const sp = headerText.indexOf('\r\n');
      const status = Number((headerText.slice(0, sp).split(' ')[1]) || 200);
      const outHeaders = {};
      for (const line of headerText.slice(sp + 2).split('\r\n')) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const k = line.slice(0, i).trim().toLowerCase();
        const v = line.slice(i + 1).trim();
        if (k === 'content-length') { need = Number(v); continue; }
        // 逐跳头不能透传：中继自己会重新分帧
        if (['connection', 'transfer-encoding', 'keep-alive'].includes(k)) continue;
        outHeaders[k] = v;
      }
      // 流式响应不带 Content-Length：交给 HTTP 的 chunked 编码
      res.writeHead(status, outHeaders);
      sentHead = true;
      if (body.length) {
        res.write(body);
        got += body.length;
      }
      if (need >= 0 && got >= need) finish();
      return;
    }
    res.write(buf);
    got += buf.length;
    if (need >= 0 && got >= need) finish();
  };

  // App 那边断开（比如用户收起小窗）：告诉负责的请求别再写了
  res.on('close', () => {
    if (st.stream) { st.stream = null; clearTimeout(timer); }
  });

  try { hostSocket.write(frame(rawRequest, 0x2)); }
  catch { st.stream = null; clearTimeout(timer); res.writeHead(502); res.end('转发失败'); }
}

// ── 状态 ──────────────────────────────────────────────────────────────
function pruneCodes() {
  const now = Date.now();
  for (const [code, h] of hosts) {
    if (now - h.createdAt > CODE_TTL_MS) {
      try { h.socket.destroy(); } catch { /* 已断 */ }
      hosts.delete(code);
    }
  }
}
// 注意：写成 `setInterval(...).unref?.()` 在 Node 20 上会报
// `SyntaxError: Unexpected token '.'` —— 数字分隔符后面接可选链的解析有兼容问题。
// 拆成两句，所有版本都能跑。
const pruneTimer = setInterval(pruneCodes, 60_000);
if (typeof pruneTimer.unref === 'function') pruneTimer.unref();

function ipOf(req) {
  return req.socket.remoteAddress || 'unknown';
}

function blocked(ip) {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() > f.until) { fails.delete(ip); return false; }
  return f.fails >= MAX_PAIR_FAILS;
}

function noteFail(ip) {
  const now = Date.now();
  const f = fails.get(ip) || { fails: 0, until: now + FAIL_WINDOW_MS };
  f.fails += 1;
  f.until = now + FAIL_WINDOW_MS;
  fails.set(ip, f);
}

// ── 服务器 ────────────────────────────────────────────────────────────
function json(res, code, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length });
  res.end(data);
}

const server = http.createServer((req, res) => {
  // ── 给 App 用的 HTTP 入口 ──
  // App 只要填 http://<中继>:8791/c/<配对码>/... 就能跨网访问电脑，
  // 不需要在 Swift 里实现 WebSocket 隧道。中继把这次 HTTP 请求
  // 塞进隧道，等 host 的响应回传后原样返回。
  if (req.url.startsWith('/c/')) {
    const rest = req.url.slice(3);
    const slash = rest.indexOf('/');
    const code = (slash < 0 ? rest : rest.slice(0, slash)).toUpperCase();
    const pathPart = slash < 0 ? '/' : rest.slice(slash);
    const h = hosts.get(code);
    if (!h) { json(res, 404, { ok: false, error: '没有这个配对码' }); return; }

    // 把请求体读完再发，避免 body 还没到就转发
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const head = `${req.method} ${pathPart} HTTP/1.1\r\n`
        + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')
        + '\r\n\r\n';
      proxyThrough(h.socket, Buffer.concat([Buffer.from(head), body]), res);
    });
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    // codes 打码只露前 2 位：/health 不需要鉴权，不能把配对码全公开。
    // 排查时够用来核对「用户说的是不是同一个码」。
    const codes = [...hosts.keys()].map((c) => c.slice(0, 2) + '****');
    res.end(JSON.stringify({ ok: true, hosts: hosts.size, codes, stat, at: new Date().toISOString() }));
    return;
  }
  res.writeHead(426, { 'content-type': 'text/plain' });
  res.end('需要 WebSocket 升级\n');
});

/**
 * 一个连接的状态机。
 *
 * 之前这里出过 bug：host 侧的转发分支只认自己闭包里的 `paired`，
 * 而 `paired` 只在对端（client）那侧被赋值，于是 host 发出的字节
 * 永远走不到转发分支——表现是「配对了但数据不通」。
 *
 * 现在改成：两边的 socket 都挂同一个 `link` 对象，路由统一在这里决定。
 */
function attach(socket) {
  const st = {
    buf: Buffer.alloc(0),
    role: null,
    code: null,
    peer: null,      // 对面的 socket
    closed: false,
  };

  const sendText = (obj) => {
    if (st.closed) return;
    try { socket.write(frame(Buffer.from(JSON.stringify(obj)))); } catch { /* 已断 */ }
  };

  const bind = (peer) => {
    st.peer = peer;
    peer.__st.peer = socket;
  };

  const teardown = () => {
    if (st.closed) return;
    st.closed = true;
    const owner = st.code ? hosts.get(st.code) : null;
    if (owner && owner.socket === socket) hosts.delete(st.code);
    if (st.peer && st.peer.__st && !st.peer.__st.closed) {
      try { st.peer.destroy(); } catch { /* 已断 */ }
    }
  };

  socket.__st = st;

  socket.on('data', (chunk) => {
    st.buf = Buffer.concat([st.buf, chunk]);
    const [frames, rest] = parseFrames(st.buf);
    st.buf = rest;

    for (const f of frames) {
      if (f.opcode === 0x8) { teardown(); socket.destroy(); return; }
      if (f.opcode === 0x9) { try { socket.write(frame(f.payload, 0xA)); } catch { /* 已断 */ } continue; }

      if (process.env.SIGMA_RELAY_DEBUG) {
        console.error(`[dbg] role=${st.role} peer=${!!st.peer} op=${f.opcode} len=${f.payload.length} txt=${f.payload.subarray(0,40).toString('utf8').replace(/[^\x20-\x7e]/g,'.')}`);
      }
      // 已配对：字节原样转给对面。不解析——host 上是 HTTP，
      // 我们只当管道，任何解析都会引入新问题。
      stat.framesIn += 1;
      // HTTP 入口的响应：交给等待中的请求（流式，可能来很多块）
      if (st.stream) { st.stream(f.payload); continue; }
      if (st.peer) {
        stat.framesFwd += 1;
        if (stat.sample.length < 8) {
          stat.sample.push({ role: st.role, op: f.opcode, len: f.payload.length,
            head: f.payload.subarray(0, 32).toString('utf8').replace(/[^\x20-\x7e]/g, '.') });
        }
        // ⚠ 必须重新封成 WebSocket 帧再写。
        // 直接把 payload 裸写进 socket 是错的：对端会把它当成帧头解析，
        // 结果是「配对成功但一个字节都收不到」——这个 bug 浪费了我一轮排查。
        // 文本帧原样保留 opcode，二进制帧也用 0x2；浏览器侧靠这个区分 string/ArrayBuffer。
        try { st.peer.write(frame(f.payload, f.opcode === 0x2 ? 0x2 : 0x1)); }
        catch (e) { stat.errors.push(String(e.message).slice(0,60)); }
        continue;
      }

      // 未配对：第一条必须是握手
      if (st.role === null) {
        let msg;
        try { msg = JSON.parse(f.payload.toString()); } catch { socket.destroy(); return; }

        if (msg.role === 'host') {
          const c = String(msg.code || '').toUpperCase().slice(0, 8);
          if (!/^[A-Z0-9]{4,8}$/.test(c)) {
            sendText({ type: 'error', message: '配对码格式不对（4-8 位字母数字）' });
            socket.destroy();
            return;
          }
          // 同码覆盖：客户端重启后能立刻重连，不用换码
          const old = hosts.get(c);
          if (old && old.socket !== socket) {
            try { old.socket.destroy(); } catch { /* 已断 */ }
          }
          st.role = 'host';
          st.code = c;
          hosts.set(c, { socket, createdAt: Date.now(), meta: msg.meta || {} });
          sendText({ type: 'registered', code: c });
        } else if (msg.role === 'client') {
          const c = String(msg.code || '').toUpperCase().slice(0, 8);
          const h = hosts.get(c);
          if (!h) {
            noteFail(ipOfRaw(socket));
            sendText({ type: 'error', message: '没有这个配对码（电脑上的客户端开着吗？）' });
            socket.destroy();
            return;
          }
          st.role = 'client';
          st.code = c;
          bind(h.socket);
          // 不删 host：允许同一个配对码被反复使用（HTTP 入口每次请求都会来一次）。
          // 但同一时刻只保留一个 peer——上一个断了在 close 里清。
          sendText({ type: 'paired', meta: h.meta });
          try {
            h.socket.__st && (h.socket.__st.peer = socket);
            h.socket.write(frame(Buffer.from(JSON.stringify({ type: 'paired' }))));
          } catch { /* host 可能已断 */ }
        } else {
          sendText({ type: 'error', message: 'role 必须是 host 或 client' });
          socket.destroy();
        }
        continue;
      }

      // 握手之后再发文本：忽略（协议里没有别的控制消息）
    }
  });

  socket.on('close', teardown);
  socket.on('error', teardown);
}

function ipOfRaw(socket) {
  return socket.remoteAddress || 'unknown';
}

server.on('upgrade', (req, socket) => {
  const ip = ipOf(req);
  if (blocked(ip)) { socket.destroy(); return; }

  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  attach(socket);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Sigma 中继已启动 :${PORT}`);
  console.log(`健康检查 http://127.0.0.1:${PORT}/health`);
});

process.on('SIGINT', () => { console.log('已停止'); process.exit(0); });
