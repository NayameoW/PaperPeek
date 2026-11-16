// 本地开发服务器：静态文件 + 一个只供本页面使用的 PDF 转发接口。
// 用法：node server.mjs   然后打开 http://localhost:8177/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8177;
const HOST = '127.0.0.1';
const MAX_BYTES = 300 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.gif': 'image/gif', '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.map': 'application/json',
  '.ttf': 'font/ttf', '.pfb': 'application/octet-stream', '.bcmap': 'application/octet-stream', '.icc': 'application/octet-stream',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

async function proxy(req, res, target) {
  // 只接受本页面自己发出的请求，避免其他网站借这个接口访问内网
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return send(res, 403, 'forbidden');
  let url;
  try { url = new URL(target); } catch { return send(res, 400, 'bad url'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return send(res, 400, 'only http(s)');
  try {
    const up = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'paperpeek-local/0.1', Accept: 'application/pdf,*/*' } });
    if (!up.ok || !up.body) return send(res, up.status || 502, `upstream ${up.status}`);
    const len = Number(up.headers.get('content-length') || 0);
    if (len > MAX_BYTES) return send(res, 413, 'too large');
    const headers = { 'Content-Type': up.headers.get('content-type') || 'application/pdf', 'Cache-Control': 'no-store' };
    if (len && !up.headers.get('content-encoding')) headers['Content-Length'] = String(len);
    res.writeHead(200, headers);
    Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
  } catch (err) {
    send(res, 502, 'fetch failed: ' + (err?.cause?.code || err?.message || err));
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
  if (u.pathname === '/proxy') return proxy(req, res, u.searchParams.get('url') || '');

  let rel = decodeURIComponent(u.pathname);
  if (rel === '/') rel = '/viewer.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep) || rel.split('/').some(s => s.startsWith('.'))) return send(res, 403, 'forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`PaperPeek 已启动： http://localhost:${PORT}/`);
});
