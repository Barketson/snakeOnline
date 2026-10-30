// abuse.js — проверка устойчивости и безопасности сервера (этап 5).
// Битый JSON, неизвестный type, огромное сообщение, невалидные поля,
// флуд, разрыв + reconnect по токену, уход хоста.
// Запуск при работающем сервере: node scripts/abuse.js
import WebSocket from 'ws';

const URL = `ws://127.0.0.1:${process.env.PORT || 3000}`;
let passed = 0, failed = 0;
const ok = name => { passed++; console.log(`PASS: ${name}`); };
const bad = (name, why) => { failed++; console.error(`FAIL: ${name}: ${why}`); };
const delay = ms => new Promise(r => setTimeout(r, ms));

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.waiters = [];
    ws.on('message', d => {
      let m;
      try { m = JSON.parse(d.toString()); } catch { return; }
      ws.waiters = ws.waiters.filter(w => !w.tryResolve(m));
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitFor(ws, pred, ms = 5000) {
  return new Promise(resolve => {
    const w = {
      tryResolve: m => {
        if (!pred(m)) return false;
        clearTimeout(w.t);
        resolve(m);
        return true;
      },
      t: setTimeout(() => resolve(null), ms),
    };
    ws.waiters.push(w);
  });
}

async function rpc(ws, msg, pred, ms = 5000) {
  const p = waitFor(ws, pred, ms);
  ws.send(JSON.stringify(msg));
  return p;
}

async function expectError(name, raw) {
  let ws;
  try {
    ws = await connect();
    const err = await new Promise(resolve => {
      const t = setTimeout(() => resolve(null), 3000);
      ws.waiters.push({
        tryResolve: m => {
          if (m.type !== 'error') return false;
          clearTimeout(t);
          resolve(m);
          return true;
        },
      });
      ws.send(raw);
    });
    if (err && typeof err.code === 'string') ok(`${name} -> error ${err.code}`);
    else bad(name, 'нет error');
  } catch (e) {
    bad(name, e.message);
  } finally {
    ws?.close();
  }
}

// Сервер жив, если новое соединение отвечает pong
async function aliveCheck(tag) {
  try {
    const ws = await connect();
    const pong = await rpc(ws, { type: 'ping' }, m => m.type === 'pong', 3000);
    if (pong) ok(`${tag}: сервер жив (ping/pong)`);
    else bad(tag, 'нет pong');
    ws.close();
  } catch (e) {
    bad(tag, `сервер недоступен: ${e.message}`);
  }
}

async function floodTest() {
  let ws;
  try {
    ws = await connect();
    for (let i = 0; i < 200; i++) ws.send(JSON.stringify({ type: 'ping' }));
    await delay(500); // лишние проигнорированы или сокет закрыт — оба исхода ок
  } catch { /* ок */ } finally {
    ws?.close();
  }
  await aliveCheck('флуд 200 сообщений');
}

async function reconnectTest() {
  try {
    const a = await connect();
    const b = await connect();
    const ja = await rpc(a, { type: 'create_room', name: 'Алиса' }, m => m.type === 'room_joined');
    const jb = await rpc(b, { type: 'join_room', code: ja.code, name: 'Боб' }, m => m.type === 'room_joined');
    await rpc(a, { type: 'start_game' }, m => m.type === 'countdown');

    b.close(); // разрыв ВО ВРЕМЯ РАУНДА
    await delay(400);

    const b2 = await connect();
    const joined = await rpc(b2, { type: 'reconnect', sessionToken: jb.sessionToken },
      m => m.type === 'room_joined' || m.type === 'error');
    if (joined && joined.type === 'room_joined' && joined.playerId === jb.playerId) {
      ok('reconnect: room_joined с тем же playerId');
    } else {
      bad('reconnect', JSON.stringify(joined));
    }
    const st = await waitFor(b2, m => m.type === 'state' && m.status === 'running', 3000);
    if (st) ok('reconnect: state продолжают приходить');
    else bad('reconnect state', 'нет state после reconnect');

    const dup = await rpc(await connect(), { type: 'reconnect', sessionToken: jb.sessionToken },
      m => m.type === 'error' || m.type === 'room_joined');
    if (dup && dup.type === 'error' && dup.code === 'no_session') ok('reconnect: повтор -> no_session');
    else bad('reconnect duplicate', JSON.stringify(dup));

    a.close(); b2.close();
  } catch (e) {
    bad('reconnect', e.message);
  }
}

async function hostLeaveTest() {
  try {
    const a = await connect();
    const b = await connect();
    const ja = await rpc(a, { type: 'create_room', name: 'Хост' }, m => m.type === 'room_joined');
    const jb = await rpc(b, { type: 'join_room', code: ja.code, name: 'Гость' },
      m => m.type === 'room_joined');
    a.send(JSON.stringify({ type: 'leave' }));
    const lu = await waitFor(b, m => m.type === 'lobby_update' && m.players.length === 1, 3000);
    if (lu && lu.hostId === jb.playerId) ok('уход хоста: hostId передан следующему');
    else bad('уход хоста', JSON.stringify(lu));
    b.close();
  } catch (e) {
    bad('уход хоста', e.message);
  }
}

async function main() {
  await expectError('битый JSON', '{"type":');
  await expectError('неизвестный type', JSON.stringify({ type: 'hack' }));
  await expectError('огромное сообщение', 'x'.repeat(2048));
  await expectError('ник с управляющими', JSON.stringify({ type: 'create_room', name: 'a\nb' }));
  await expectError('невалидный dir', JSON.stringify({ type: 'input', dir: [1, 1] }));
  await expectError('код комнаты мимо алфавита', JSON.stringify({ type: 'join_room', code: '00000', name: 'Боб' }));
  await floodTest();
  await reconnectTest();
  await hostLeaveTest();
  await aliveCheck('финальная проверка');
  console.log(`\nИтог: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
