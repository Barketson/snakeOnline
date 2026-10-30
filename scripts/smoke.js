// Смоук-тест этапа 2: 2 WS-клиента в одном процессе.
// create_room -> join_room -> start_game -> повороты -> state* -> round_end.
// Запуск: node server/index.js &  затем  node scripts/smoke.js
import WebSocket from 'ws';

const URL = `ws://127.0.0.1:${process.env.PORT || 3000}`;
const WAIT_MS = 45000; // запас: отсчёт 3с + до ~7с игры

const fail = (why) => { console.error(`FAIL: ${why}`); process.exit(1); };
const timer = setTimeout(() => fail('таймаут: round_end не пришёл'), WAIT_MS + 5000);

class Client {
  constructor(name) {
    this.name = name;
    this.states = 0;
    this.inputs = 0;
    this.waiters = [];
    this.tickN = 0;
    this.turns = 0;
  }
  connect() {
    this.ws = new WebSocket(URL);
    this.ws.on('message', (d) => {
      let m;
      try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.type === 'state') this.onState(m);
      this.waiters = this.waiters.filter(w => !w.tryResolve(m));
    });
    return new Promise((res, rej) => {
      this.ws.on('open', res);
      this.ws.on('error', rej);
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  waitFor(pred, label) {
    return new Promise((resolve, reject) => {
      const w = {
        tryResolve: (m) => {
          if (!pred(m)) return false;
          clearTimeout(w.t);
          resolve(m);
          return true;
        },
        t: setTimeout(() => reject(new Error(`таймаут ожидания: ${label}`)), WAIT_MS),
      };
      this.waiters.push(w);
    });
  }
  // Зигзаг: каждые 3 тика — валидный поворот на 90° (чередуем сторону).
  // Змейки гарантированно врезаются в стены, раунд завершается быстро.
  onState(s) {
    this.states++;
    const me = s.snakes.find(x => x.id === this.playerId);
    if (s.status !== 'running' || !me || !me.alive) return;
    this.tickN++;
    if (this.tickN % 3 !== 0) return;
    const [dx, dy] = me.dir;
    const dir = this.turns % 2 === 0 ? [dy, -dx] : [-dy, dx]; // ±90°, никогда 180°
    this.send({ type: 'input', dir });
    this.turns++;
    this.inputs++;
  }
}

function checkRoomJoined(m, who) {
  const ok = m.code && typeof m.code === 'string' && m.code.length === 5
    && m.playerId && m.sessionToken && m.hostId && Array.isArray(m.players);
  if (!ok) fail(`${who}: битый room_joined: ${JSON.stringify(m)}`);
}

// Цвета должны быть уникальны среди ТЕКУЩИХ игроков комнаты —
// в т.ч. после череды выходов/входов (регрессия colorIdx).
function checkUniqueColors(players, tag) {
  const colors = players.map(p => p.color);
  if (new Set(colors).size !== colors.length) {
    fail(`${tag}: дубли цветов: ${JSON.stringify(players.map(p => ({ name: p.name, color: p.color })))}`);
  }
}

async function main() {
  const a = new Client('Алиса');
  const b = new Client('Боб');
  await Promise.all([a.connect(), b.connect()]);

  a.send({ type: 'create_room', name: 'Алиса' });
  const ja = await a.waitFor(m => m.type === 'room_joined', 'room_joined A');
  checkRoomJoined(ja, 'A');
  a.playerId = ja.playerId;

  b.send({ type: 'join_room', code: ja.code, name: 'Боб' });
  const [jb] = await Promise.all([
    b.waitFor(m => m.type === 'room_joined', 'room_joined B'),
    a.waitFor(m => m.type === 'lobby_update' && m.players.length === 2, 'lobby_update A'),
  ]);
  checkRoomJoined(jb, 'B');
  b.playerId = jb.playerId;
  if (ja.code !== jb.code || jb.players.length !== 2) fail('код/состав комнаты не сошёлся');
  checkUniqueColors(jb.players, 'после входа B');

  const endA = a.waitFor(m => m.type === 'round_end', 'round_end A').catch(e => fail(e.message));
  const endB = b.waitFor(m => m.type === 'round_end', 'round_end B').catch(e => fail(e.message));
  const lobbyA = a.waitFor(m => m.type === 'lobby_update', 'lobby после раунда');

  a.send({ type: 'start_game' });
  await a.waitFor(m => m.type === 'countdown', 'countdown');
  await Promise.all([endA, endB]);

  const ra = await endA, rb = await endB;
  if (a.states < 5 || b.states < 5) fail(`мало state: A=${a.states} B=${b.states}`);
  if (a.inputs < 2 || b.inputs < 2) fail(`мало input: A=${a.inputs} B=${b.inputs}`);
  for (const [tag, r] of [['A', ra], ['B', rb]]) {
    if (!Array.isArray(r.results) || r.results.length !== 2) fail(`${tag}: битый results`);
    if (!Array.isArray(r.sessionScore) || r.sessionScore.length !== 2) fail(`${tag}: битый sessionScore`);
    for (const p of r.results) {
      if (!('place' in p) || !('len' in p) || !('score' in p) || !p.name || !p.color) fail(`${tag}: неполный результат`);
    }
  }
  if (ra.results[0].id !== rb.results[0].id) fail('итоги у A и B различаются');
  await lobbyA;

  // Регрессия уникальности цветов: B выходит и заходит заново —
  // цвета ТЕКУЩИХ игроков обязаны остаться уникальными.
  // (sessionScore хранит счёт за сессию, поэтому проверка после итогов раунда)
  b.send({ type: 'leave' });
  await a.waitFor(m => m.type === 'lobby_update' && m.players.length === 1, 'lobby_update после выхода B');
  b.send({ type: 'join_room', code: ja.code, name: 'Боб' });
  const [jb2] = await Promise.all([
    b.waitFor(m => m.type === 'room_joined', 'room_joined B повторно'),
    a.waitFor(m => m.type === 'lobby_update' && m.players.length === 2, 'lobby_update A повторно'),
  ]);
  checkRoomJoined(jb2, 'B повторно');
  checkUniqueColors(jb2.players, 'после rejoin B');

  clearTimeout(timer);
  console.log(`OK: create/join/start/input/state/round_end. ` +
    `state: A=${a.states} B=${b.states}, inputs: A=${a.inputs} B=${b.inputs}, ` +
    `winner=${ra.results[0].name} (${ra.results[0].score} очков)`);
  process.exit(0);
}

main().catch(e => fail(e.message));
