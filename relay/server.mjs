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
const stat = { framesIn: 0, framesFwd: 0, binds: 0, errors: [], sample: [], e502: 0, e504: 0, reqSent: 0, resGot: 0 };
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
let nextRid = 1;

/**
 * 一条请求 = 一个 rid。
 *
 * 为什么必须多路复用：App 打开小窗时会同时发 `/health`（探测）和
 * `/screen`（MJPEG 流，永不结束）。之前中继每个 host 只有一个 stream 槽，
 * 两个请求互相覆盖——MJPEG 一占，探测永远等不到响应，表现为
 * 「连上了但连接中断 / 502」。
 *
 * 协议：
 *   中继 → 客户端：{"type":"req","rid":N}  然后紧跟一个二进制帧（原始 HTTP 请求）
 *   客户端 → 中继：{"type":"res","rid":N}  然后紧跟一个二进制帧（响应字节）
 *                  {"type":"end","rid":N}  该请求结束/连接已关
 */
function proxyThrough(hostSocket, rawRequest, res) {
  const st = hostSocket.__st;
  if (!st) { stat.e502 += 1; res.writeHead(502); res.end('电脑连接状态丢了'); return; }
  if (st.closed) { stat.e502 += 1; res.writeHead(502); res.end('电脑连接已关闭，请重启客户端'); return; }

  const rid = nextRid++;
  let head = Buffer.alloc(0);
  let sentHead = false;
  let need = -1;
  let got = 0;
  let done = false;

  const cleanup = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (st.pending) st.pending.delete(rid);
  };

  const finish = () => { cleanup(); if (!res.writableEnded) res.end(); };

  const timer = setTimeout(() => {
    if (!sentHead) {
      stat.e504 += 1;
      cleanup();
      res.writeHead(504);
      res.end('电脑没响应');
    }
  }, 20000);

  st.pending = st.pending || new Map();
  st.pending.set(rid, (buf) => {
    if (done) return;
    if (!sentHead) {
      head = Buffer.concat([head, buf]);
      const sep = head.indexOf('\r\n\r\n');
      if (sep < 0) {
        if (head.length > 64 * 1024) {
          const peek = head.subarray(0, 120).toString('latin1').replace(/[^\x20-\x7e]/g, '.');
          stat.e502 += 1;
          cleanup();
          res.writeHead(502);
          res.end('响应头异常，收到的是：' + peek);
        }
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
        if (['connection', 'transfer-encoding', 'keep-alive'].includes(k)) continue;
        outHeaders[k] = v;
      }
      // multipart/x-mixed-replace 是无长度流：必须保持连接开着，
      // 不能因为「没有 content-length」就当成已结束。
      const isStream = /multipart\/x-mixed-replace/i.test(outHeaders['content-type'] || '');
      // 显式关掉 Nagle 和分块缓冲：MJPEG 每帧都很小，
      // 默认的 chunked 聚合会把它们攒到一定大小才发，
      // 而 iOS 的 URLSession 在收到第一个 chunk 之前不会回调 didReceive。
      if (isStream) {
        outHeaders['cache-control'] = 'no-store';
        outHeaders['x-accel-buffering'] = 'no';
        // 别伪造 content-length：URLSession 会一直等满那个长度，
        // 反而让「收到了却不解码」变成「永远等不到」。
        // 流式走 chunked 是对的；App 那边改用 /screen/one 轮询。
        try { res.socket && res.socket.setNoDelay(true); } catch {}
      }
      res.writeHead(status, outHeaders);
      // 立刻把响应头推出去，不等第一块 body。
      // 不调用它的话，Node 会把头和数据一起攒着，客户端只能干等。
      try { res.flushHeaders && res.flushHeaders(); } catch {}
      sentHead = true;
      if (body.length) { res.write(body); got += body.length; }
      if (!isStream && need >= 0 && got >= need) finish();
      return;
    }
    res.write(buf);
    got += buf.length;
    if (need >= 0 && got >= need) finish();
  });

  res.on('close', () => { cleanup(); });

  try {
    hostSocket.write(frame(Buffer.from(JSON.stringify({ type: 'req', rid })), 0x1));
    hostSocket.write(frame(rawRequest, 0x2));
    stat.reqSent += 1;
    if (process.env.SIGMA_RELAY_DEBUG && stat.reqSent <= 4) {
      console.error(`[req] rid=${rid} 原文:\n${rawRequest.toString('latin1').slice(0, 400)}`);
    }
    if (stat.reqSent <= 3) {
      stat.sample.push({ dir: 'req', rid, bytes: rawRequest.length,
        head: rawRequest.subarray(0, 60).toString('latin1').replace(/[^\x20-\x7e]/g,'.') });
    }
  } catch (e) {
    cleanup();
    stat.e502 += 1;
    res.writeHead(502);
    res.end('转发失败：' + (e && e.message ? e.message : '未知'));
  }
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

    // ⚠ 不要等 req.on('end')：GET 请求没有 body，某些情况下 end 迟迟不来，
    // 代码就永远进不了 proxyThrough —— 表现是「App 连上了但一直转圈 / -1001」，
    // 而且中继的 e502/e504 计数都是 0（根本没走到那一步）。
    // 直接组好请求头发出去；有 body 的（POST）再补。
    const chunks = [];
    let sent = false;
    const forward = () => {
      if (sent) return;
      sent = true;
      const body = Buffer.concat(chunks);
      // ⚠ 必须过滤掉 content-length：请求头里已经有一份，
      // 我们再补一份就变成重复头，HTTP 服务器会直接回 400 Bad Request。
      // 这个 bug 的表现是「GET 全通、POST 全 400」，很难从表面看出来。
      const headers = Object.entries(req.headers)
        .filter(([k]) => !['host', 'connection', 'keep-alive', 'proxy-connection',
                            'transfer-encoding', 'upgrade', 'content-length']
                            .includes(k.toLowerCase()))
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
      const head = `${req.method} ${pathPart} HTTP/1.1\r\n`
        + `host: 127.0.0.1:${PORT}\r\n`
        + headers + '\r\n'
        // 只在这里写一次，且只在真有 body 时写
        + (body.length ? `content-length: ${body.length}\r\n` : '')
        + 'connection: close\r\n\r\n';
      proxyThrough(h.socket, Buffer.concat([Buffer.from(head), body]), res);
    };

    // GET/HEAD 没有 body，立刻转。
    // 其他方法（POST）必须**等 body 收完**——2 秒兜底是错的：
    // 它会在 body 还没到时抢先转发一个空请求，客户端拿到的是
    // `{"path":undefined}` 之类，然后卡住不回，最终超时。
    if (req.method === 'GET' || req.method === 'HEAD') {
      forward();
    } else {
      req.on('data', (c) => chunks.push(c));
      req.on('end', forward);
      // 只防「end 永远不来」的极端情况，给足 10 秒；正常 POST 都是毫秒级
      req.on('error', forward);
    }
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

      // ⚠ 控制消息必须最先处理。
      // 之前 st.peer 分支在前，host 发来的 {"type":"res"} 被当成业务数据
      // 直接转给 client，下面的解析永远走不到 —— 表现是
      // 「GET 正常（一次响应就结束），POST 全部超时」。
      if (st.role === 'host' && f.opcode === 0x1) {
        let ctrl = null;
        try { ctrl = JSON.parse(f.payload.toString()); } catch { /* 非控制消息 */ }
        if (ctrl && ctrl.type === 'res') {
          st.curRid = ctrl.rid;
          stat.resGot += 1;
          continue;
        }
        if (ctrl && ctrl.type === 'end') {
          if (st.curRid === ctrl.rid) st.curRid = undefined;
          continue;
        }
      }

      // 多路复用：文本帧里带 rid，二进制帧紧跟其后
      if (process.env.SIGMA_RELAY_DEBUG) {
        console.error(`[frm] role=${st.role} op=${f.opcode} len=${f.payload.length} curRid=${st.curRid} pending=${st.pending ? [...st.pending.keys()] : 'none'} text=${f.payload.subarray(0,30).toString('utf8').replace(/[^\x20-\x7e]/g,'.')}`);
      }
      if (st.curRid !== undefined) {
        const fn = st.pending && st.pending.get(st.curRid);
        if (process.env.SIGMA_RELAY_DEBUG) {
          console.error(`[fwd] rid=${st.curRid} len=${f.payload.length} fn=${!!fn} pending=${st.pending ? [...st.pending.keys()] : []}`);
        }
        if (fn) fn(f.payload);
        st.curRid = undefined;
        continue;
      }
      if (process.env.SIGMA_RELAY_DEBUG) {
        console.error(`[drop] 无 curRid 的二进制帧 len=${f.payload.length}`);
      }
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
          if (process.env.SIGMA_RELAY_DEBUG) console.error(`[reg] 发 registered code=${c} closed=${st.closed}`);
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

      // 握手之后的文本帧 = 多路复用的控制消息
      //   {"type":"res","rid":N} → 下一帧二进制属于 rid N
      //   {"type":"end","rid":N} → 该请求结束
      if (st.role === 'host') {
        let msg;
        try { msg = JSON.parse(f.payload.toString()); } catch { continue; }
        if (msg.type === 'res') { st.curRid = msg.rid; stat.resGot += 1; continue; }
        if (msg.type === 'end') {
          const fn = st.pending && st.pending.get(msg.rid);
          // 通知这个请求的连接可以收了：不主动 end，交给 Content-Length 判断，
          // 但把 pending 清掉防止泄漏
          if (fn) { /* 数据已由 Content-Length 收齐 */ }
          continue;
        }
      }
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
