// gemini-proxy v6 (Node.js 事件驱动版)
// 根治:PowerShell runspace 单线程,并发时请求排队挂死 -> Node 事件驱动天然并发
// 功能:剥离 Gemini 原生字段(thinking/enable_thinking/reasoning) + 缓存并补回 thought_signature
// 出口:ProxyEnable=1 时走系统 HTTP 代理(CONNECT 隧道),否则直连
// 测试:环境变量 TARGET_URL=http://127.0.0.1:xxx 可将上游指向本地 mock(不依赖外网)

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';
import { execFileSync } from 'node:child_process';

const PORT = 8899;
const TARGET = process.env.TARGET_URL || 'https://generativelanguage.googleapis.com';
const TARGET_URL = new URL(TARGET);
const TARGET_HOST = TARGET_URL.hostname;
const TARGET_PORT = Number(TARGET_URL.port) || (TARGET_URL.protocol === 'http:' ? 80 : 443);
const IS_HTTPS = TARGET_URL.protocol === 'https:';
const BANNED_FIELDS = new Set(['thinking', 'enable_thinking', 'reasoning']);
const sigCache = new Map(); // callId -> thought_signature
const logFile = path.join(os.homedir(), '.zcode', 'gemini-proxy.log');

function log(s) {
  const line = `[${new Date().toISOString()}] ${s}`;
  try { fs.appendFileSync(logFile, line + '\n', 'utf8'); } catch { }
  console.log(line);
}

// ---------- 出口代理发现(缓存 30s) ----------
let egressCache = { t: 0, url: null };
function currentEgress() {
  const now = Date.now();
  if (now - egressCache.t < 30000) return egressCache.url;
  let proxyUrl = null;
  try {
    const out = execFileSync('reg', [
      'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
      '/v', 'ProxyEnable'
    ], { encoding: 'utf8' });
    const m = /0x([0-9a-fA-F]+)/.exec(out);
    const enabled = m && parseInt(m[1], 16) === 1;
    if (enabled) {
      const out2 = execFileSync('reg', [
        'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
        '/v', 'ProxyServer'
      ], { encoding: 'utf8' });
      const s = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(out2);
      if (s) proxyUrl = s[1];
    }
  } catch { }
  if (envProxy()) proxyUrl = envProxy();
  if (proxyUrl && !/^https?:\/\//.test(proxyUrl)) proxyUrl = 'http://' + proxyUrl;
  let parsed = null;
  try { parsed = proxyUrl ? new URL(proxyUrl) : null; } catch { parsed = null; }
  egressCache = { t: now, url: parsed };
  return parsed;
}
function envProxy() {
  return process.env.HTTPS_PROXY || process.env.https_proxy ||
         process.env.HTTP_PROXY || process.env.http_proxy || null;
}

// ---------- 经系统代理 CONNECT 隧道连上游(否则直连) ----------
function upstreamSocket(cb) {
  const e = currentEgress();
  log('upstreamSocket egress=' + (e ? e.href : 'DIRECT'));
  // 本机目标(localhost/127.0.0.1/::1)永远直连,不走系统代理
  if (e && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(TARGET_HOST)) {
    log('upstreamSocket forcing DIRECT (local target)');
    const direct = (!IS_HTTPS)
      ? net.connect(TARGET_PORT, TARGET_HOST)
      : tls.connect({ host: TARGET_HOST, port: TARGET_PORT, servername: TARGET_HOST });
    if (!IS_HTTPS) {
      direct.on('connect', () => cb(null, direct));
      direct.on('error', cb);
    } else {
      direct.on('error', cb);
      direct.on('secureConnect', () => { direct.removeListener('error', cb); cb(null, direct); });
    }
    return;
  }
  if (!e) {
    // 直连:必须等 socket 连接完成再回调,否则 http.request 拿到未连接 socket 会挂起
    if (!IS_HTTPS) {
      const s = net.connect(TARGET_PORT, TARGET_HOST);
      s.on('connect', () => cb(null, s));
      s.on('error', cb);
      return;
    }
    const sock = tls.connect({ host: TARGET_HOST, port: TARGET_PORT, servername: TARGET_HOST });
    sock.on('error', cb);
    sock.on('secureConnect', () => { sock.removeListener('error', cb); cb(null, sock); });
    return;
  }
  // 经 HTTP 代理:先 CONNECT,再 TLS
  const proxyPort = Number(e.port) || 80;
  const raw = net.connect(proxyPort, e.hostname, () => {
    raw.write(`CONNECT ${TARGET_HOST}:${TARGET_PORT} HTTP/1.1\r\nHost: ${TARGET_HOST}:${TARGET_PORT}\r\n\r\n`);
  });
  let buf = '';
  const onData = (d) => {
    buf += d.toString('latin1');
    const idx = buf.indexOf('\r\n\r\n');
    if (idx === -1) return;
    raw.removeListener('data', onData);
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(buf.slice(0, idx));
    if (status && status[1] === '200') {
      if (!IS_HTTPS) return cb(null, raw);
      const sock = tls.connect({ socket: raw, servername: TARGET_HOST });
      sock.on('error', cb);
      sock.on('secureConnect', () => { sock.removeListener('error', cb); cb(null, sock); });
    } else {
      raw.destroy();
      cb(new Error('CONNECT failed: ' + buf.slice(0, idx)));
    }
  };
  raw.on('data', onData);
  raw.on('error', cb);
}

// ---------- 请求修正:剥离字段 + 注入签名 ----------
function stripUnknown(o) {
  let removed = false;
  if (Array.isArray(o)) {
    for (const v of o) if (stripUnknown(v)) removed = true;
    return removed;
  }
  if (!o || typeof o !== 'object') return false;
  for (const k of Object.keys(o)) {
    if (BANNED_FIELDS.has(k)) { delete o[k]; removed = true; }
    else if (o[k] && typeof o[k] === 'object' && stripUnknown(o[k])) removed = true;
  }
  return removed;
}

function fixRequestBody(bodyText) {
  let j;
  try { j = JSON.parse(bodyText); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const stripped = stripUnknown(j);

  let injected = 0;
  const msgs = Array.isArray(j.messages) ? j.messages : [];
  for (const msg of msgs) {
    if (msg && msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        const cid = call && call.id;
        if (!cid || !sigCache.has(cid)) continue;
        const sig = sigCache.get(cid);
        if (sig === undefined) continue;
        const has = !!(call.extra_content && call.extra_content.google && call.extra_content.google.thought_signature !== undefined);
        if (!has) {
          if (!call.extra_content) call.extra_content = {};
          if (!call.extra_content.google) call.extra_content.google = {};
          call.extra_content.google.thought_signature = sig;
          injected++;
        }
      }
    }
  }
  if (stripped) log('STRIP removed Gemini-native fields (thinking/enable_thinking/reasoning)');
  if (injected > 0) log(`INJECT restored thought_signature on ${injected} tool call(s)`);
  if (!stripped && injected === 0) return null;
  return JSON.stringify(j);
}

// ---------- SSE 扫描:缓存签名 ----------
function scanSseChunk(chunk, asm) {
  asm.buffer += chunk;
  let nl;
  while ((nl = asm.buffer.indexOf('\n')) >= 0) {
    const line = asm.buffer.slice(0, nl).replace(/\r$/, '');
    asm.buffer = asm.buffer.slice(nl + 1);
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') continue;
    try {
      const j = JSON.parse(payload);
      if (j && Array.isArray(j.choices)) {
        for (const ch of j.choices) {
          const delta = ch && ch.delta;
          if (!delta || !Array.isArray(delta.tool_calls)) continue;
          for (const tc of delta.tool_calls) {
            const sig = tc && tc.extra_content && tc.extra_content.google && tc.extra_content.google.thought_signature;
            if (sig !== undefined) {
              const key = tc.index !== undefined ? String(tc.index) : '0';
              if (!asm.calls[key]) asm.calls[key] = {};
              asm.calls[key].sig = sig;
              if (tc.id) asm.calls[key].id = tc.id;
            }
          }
        }
      }
    } catch { }
  }
}

function flushAssembler(asm) {
  for (const k of Object.keys(asm.calls)) {
    const e = asm.calls[k];
    if (e.id && e.sig !== undefined && !sigCache.has(e.id)) {
      sigCache.set(e.id, e.sig);
      log(`CACHED signature for ${e.id}`);
    }
  }
}

// ---------- 处理单个请求 ----------
async function handle(req, res) {
  const reqPath = req.url || '/';
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  let forwardBody = body;

  if (body.length > 0 && reqPath.includes('/chat/completions')) {
    const fixed = fixRequestBody(body.toString('utf8'));
    if (fixed) {
      log(`REWRITE request body, new length ${Buffer.byteLength(fixed)}`);
      forwardBody = Buffer.from(fixed, 'utf8');
    }
  }

  const headers = { ...req.headers, host: TARGET_HOST, connection: 'close' };
  delete headers['proxy-connection'];
  // 请求体被改写(剥离/注入)后,content-length 必须同步,否则上游傻等旧长度永不响应
  if (forwardBody.length > 0) {
    headers['content-length'] = String(forwardBody.length);
  } else {
    headers['content-length'] = '0';
  }

  const upstream = (TARGET_URL.protocol === 'http:' ? http : https).request({
    host: TARGET_HOST,
    port: TARGET_PORT,
    path: TARGET_URL.pathname.replace(/\/$/, '') + reqPath,
    method: req.method,
    headers,
    createConnection: (opts, cb) => upstreamSocket(cb),
  });

  // 建连阶段 60s,响应开始后 20 分钟无数据才判死(思考静默期)
  upstream.setTimeout(60000, () => upstream.destroy(new Error('upstream connect timeout')));
  upstream.on('response', (upRes) => {
    log('UPSTREAM RESPONSE status=' + (upRes.statusCode || '?'));
    res.statusCode = upRes.statusCode || 200;
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (k.toLowerCase() === 'set-cookie') continue;
      res.setHeader(k, v);
    }
    const isSse = String(upRes.headers['content-type'] || '').includes('event-stream');
    const asm = { buffer: '', calls: {} };
    if (isSse) log('STREAM begin ' + reqPath);
    let timer = null;
    upRes.on('data', (d) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { try { res.destroy(); } catch { } }, 1200000);
      if (!res.writableEnded) res.write(d);
      if (isSse) scanSseChunk(d.toString('utf8'), asm);
    });
    upRes.on('end', () => {
      if (timer) clearTimeout(timer);
      if (isSse && Object.keys(asm.calls).length > 0) flushAssembler(asm);
      if (!res.writableEnded) res.end();
      log('OK ' + new Date().toISOString() + ' ' + reqPath);
    });
    upRes.on('error', (e) => { try { res.destroy(); } catch { } log('UPSTREAM-STREAM-ERR ' + e.message); });
  });
  if (forwardBody.length > 0) { upstream.write(forwardBody); log('UPSTREAM BODY sent ' + forwardBody.length + ' bytes'); }
  upstream.end();
  upstream.on('error', (e) => {
    log('UPSTREAM-FAIL ' + e.message);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { message: e.message } }));
    } else if (!res.writableEnded) {
      res.destroy();
    }
  });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    log('HANDLER-FAIL ' + (e && e.message));
    if (!res.writableEnded) res.destroy();
  });
});

// 启动自检:用与转发完全相同的上游连接路径测一次上游,便于定位问题
function selfCheck() {
  upstreamSocket((err, sock) => {
    if (err) { log('SELFCHECK upstream connect FAIL: ' + err.message); return; }
    log('SELFCHECK upstream connect OK');
    if (sock && sock.destroy) sock.destroy();
  });
}
setTimeout(selfCheck, 1000);

server.keepAliveTimeout = 120000;       // 连接空闲保持 2 分钟
server.requestTimeout = 0;              // 请求无超时(长流式)
server.headersTimeout = 300000;
server.listen(PORT, '127.0.0.1', () => {
  log(`=== proxy v6 listening on http://127.0.0.1:${PORT}, upstream=${TARGET} ===`);
});