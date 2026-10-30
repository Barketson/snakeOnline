// HTTP (статика /public) + WebSocket на том же порту — ARCHITECTURE.md §3.4
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MAX_MESSAGE_BYTES, RATE_LIMIT_PER_SEC } from './config.js';
import { handleMessage, handleClose, ProtocolError } from './rooms.js';

const PORT = process.env.PORT || 3000;
const RATE_WINDOW_MS = 1000;    // скользящее 1-секундное окно счётчика
const RATE_HARD_LIMIT = 200;    // грубое превышение -> ws.close()
const HEARTBEAT_MS = 30000;     // серверный ping/pong: не ответил — terminate
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};
const contentType = p => MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';

// ---------- статика ----------
const server = http.createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.includes('\0') || pathname.includes('..') || pathname.includes('\\')) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('400');
      return;
    }
    if (pathname === '/') pathname = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!file.startsWith(PUBLIC_DIR)) { // страховка от path traversal
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': contentType(file) });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

function replyError(ws, code, message) {
  try { ws.send(JSON.stringify({ type: 'error', code, message })); } catch { /* соединение закрылось */ }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.rlCount = 0;           // счётчик сообщений rate limit
  ws.rlWindowStart = Date.now();
  ws.on('message', (data) => {
    try {
      // rate limit: >RATE_LIMIT_PER_SEC/с игнорируются молча,
      // грубый флуд (>RATE_HARD_LIMIT в окне) — закрываем соединение
      const now = Date.now();
      if (now - ws.rlWindowStart >= RATE_WINDOW_MS) {
        ws.rlWindowStart = now;
        ws.rlCount = 0;
      }
      ws.rlCount++;
      if (ws.rlCount > RATE_LIMIT_PER_SEC) {
        if (ws.rlCount > RATE_HARD_LIMIT) ws.close();
        return; // лишние — без ответа
      }
      if (data.length > MAX_MESSAGE_BYTES) {
        replyError(ws, 'bad_request', 'сообщение слишком большое');
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        replyError(ws, 'bad_request', 'невалидный JSON');
        return;
      }
      if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
        replyError(ws, 'bad_request', 'нужен объект с полем type');
        return;
      }
      handleMessage(ws, msg);
    } catch (err) {
      if (err instanceof ProtocolError) {
        replyError(ws, err.code, err.message);
      } else {
        console.error('[index] ошибка обработки сообщения:', err); // не роняем процесс
        replyError(ws, 'internal', 'внутренняя ошибка сервера');
      }
    }
  });
  ws.on('close', () => handleClose(ws));
  ws.on('error', () => { /* игнор; close придёт отдельно */ });
});

// heartbeat: isAlive сбрасываем перед ping; не ответил pong — terminate
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* сокет уже мёртв */ }
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[index] слушаю http://0.0.0.0:${PORT}`);
});
