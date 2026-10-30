// Детерминированные тесты чистой логики (node:test). Сценарии: ARCHITECTURE.md §6, этап 1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, queueInput, step, serialize } from '../server/game.js';
import { TICK_RATE, COUNTDOWN_SECONDS, FOOD_POINTS, ROUND_DURATION_MS, TICK_MS } from '../server/config.js';

const COUNTDOWN_STEPS = COUNTDOWN_SECONDS * TICK_RATE;
const mkPlayers = n => Array.from({ length: n }, (_, i) => ({ id: 'p' + (i + 1), name: 'Игрок' + (i + 1), color: '#00FFFF' }));
const cyc = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };

function freshGame(n, rng = cyc(0.99)) {
  const state = createGame(mkPlayers(n), rng);
  state.food = []; // убираем случайную еду, чтобы не мешала сценариям
  return state;
}
const finishCountdown = state => { for (let i = 0; i < COUNTDOWN_STEPS; i++) step(state); };
const setSnake = (state, i, body, dir) => { const s = state.snakes[i]; s.body = body.map(([x, y]) => ({ x, y })); s.dir = { x: dir[0], y: dir[1] }; s.inputQueue = []; };
const head = s => s.body[0];

test('движение: голова сдвигается по направлению каждый тик', () => {
  const state = freshGame(1);
  setSnake(state, 0, [[5, 5], [4, 5], [3, 5]], [1, 0]);
  finishCountdown(state);
  assert.equal(state.status, 'running');
  step(state);
  assert.deepEqual(head(state.snakes[0]), { x: 6, y: 5 });
  assert.equal(state.snakes[0].body.length, 3);
  step(state);
  assert.deepEqual(head(state.snakes[0]), { x: 7, y: 5 });
});

test('отсчёт: змейки стоят, статус countdown -> running', () => {
  const state = freshGame(1);
  setSnake(state, 0, [[5, 5], [4, 5], [3, 5]], [1, 0]);
  const before = JSON.stringify(state.snakes[0].body);
  step(state);
  assert.equal(state.status, 'countdown');
  assert.equal(JSON.stringify(state.snakes[0].body), before);
  finishCountdown(state);
  assert.equal(state.status, 'running');
  assert.equal(state.countdownTicks, 0);
});

test('запрет разворота на 180°', () => {
  const state = freshGame(1);
  setSnake(state, 0, [[5, 5], [4, 5], [3, 5]], [1, 0]);
  finishCountdown(state);
  queueInput(state, 'p1', { x: -1, y: 0 });
  assert.equal(state.snakes[0].inputQueue.length, 0);
  step(state);
  assert.deepEqual(head(state.snakes[0]), { x: 6, y: 5 }); // поехала прямо
});

test('буфер из двух поворотов, третий отклонён', () => {
  const state = freshGame(1);
  setSnake(state, 0, [[5, 5], [4, 5], [3, 5]], [1, 0]);
  finishCountdown(state);
  queueInput(state, 'p1', { x: 0, y: -1 }); // вверх
  queueInput(state, 'p1', { x: -1, y: 0 }); // влево (относительно хвоста очереди — легально)
  queueInput(state, 'p1', { x: 0, y: 1 });  // очередь полна — игнор
  assert.equal(state.snakes[0].inputQueue.length, 2);
  step(state);
  assert.deepEqual(head(state.snakes[0]), { x: 5, y: 4 }); // применён первый поворот
  step(state);
  assert.deepEqual(head(state.snakes[0]), { x: 4, y: 4 }); // применён второй
});

test('рост от еды: +очки сразу, +длина на следующий тик', () => {
  const state = freshGame(1);
  setSnake(state, 0, [[5, 5], [4, 5], [3, 5]], [1, 0]);
  finishCountdown(state);
  state.food = [{ x: 6, y: 5 }];
  const res = step(state);
  const s = state.snakes[0];
  assert.equal(s.score, FOOD_POINTS);
  assert.equal(s.body.length, 3); // хвост ещё срезан, рост впереди
  assert.ok(res.events.some(e => e.type === 'eat' && e.playerId === 'p1'));
  assert.equal(state.food.length, 3); // дозаполнение до players + 2 (соло: 1 + 2)
  assert.ok(!state.food.some(f => f.x === 6 && f.y === 5)); // съеденное яблоко удалено
  step(state);
  assert.equal(s.body.length, 4); // хвост остался — змейка выросла
});

test('смерть о стену', () => {
  const state = freshGame(2);
  setSnake(state, 0, [[state.grid.w - 1, 10], [state.grid.w - 2, 10], [state.grid.w - 3, 10]], [1, 0]);
  setSnake(state, 1, [[5, 20], [5, 21], [5, 22]], [0, -1]);
  finishCountdown(state);
  const res = step(state);
  assert.equal(state.snakes[0].alive, false);
  assert.ok(res.events.some(e => e.type === 'death' && e.playerId === 'p1' && e.reason === 'wall'));
  assert.equal(state.snakes[1].alive, true);
});

test('смерть о своё тело', () => {
  const state = freshGame(1);
  setSnake(state, 0, [[2, 2], [2, 3], [2, 4], [3, 4]], [1, 0]);
  finishCountdown(state);
  queueInput(state, 'p1', { x: 0, y: 1 }); // разворот вниз в своё тело
  const res = step(state);
  assert.equal(state.snakes[0].alive, false);
  assert.ok(res.events.some(e => e.type === 'death' && e.playerId === 'p1' && e.reason === 'self'));
});

test('смерть о чужое тело', () => {
  const state = freshGame(2);
  setSnake(state, 0, [[4, 6], [4, 7], [4, 8]], [1, 0]);    // врежется в (5,6)
  setSnake(state, 1, [[5, 4], [5, 5], [5, 6], [5, 7]], [0, -1]);
  finishCountdown(state);
  const res = step(state);
  assert.equal(state.snakes[0].alive, false);
  assert.ok(res.events.some(e => e.type === 'death' && e.playerId === 'p1' && e.reason === 'other'));
  assert.equal(state.snakes[1].alive, true);
});

test('лоб в лоб: две головы в одной клетке', () => {
  const state = freshGame(2);
  setSnake(state, 0, [[2, 3], [2, 4], [2, 5]], [1, 0]);
  setSnake(state, 1, [[4, 3], [4, 4], [4, 5]], [-1, 0]);
  finishCountdown(state);
  const res = step(state);
  assert.equal(state.snakes[0].alive, false);
  assert.equal(state.snakes[1].alive, false);
  const deaths = res.events.filter(e => e.type === 'death');
  assert.equal(deaths.length, 2);
  assert.ok(deaths.every(e => e.reason === 'head'));
});

test('лоб в лоб: обмен клетками за тик', () => {
  const state = freshGame(2);
  setSnake(state, 0, [[2, 3], [2, 4], [2, 5]], [1, 0]);
  setSnake(state, 1, [[3, 3], [3, 4], [3, 5]], [-1, 0]);
  finishCountdown(state);
  const res = step(state);
  assert.equal(state.snakes[0].alive, false);
  assert.equal(state.snakes[1].alive, false);
  assert.ok(res.events.filter(e => e.type === 'death').every(e => e.reason === 'head'));
});

test('хвост освобождает клетку: в неё можно въехать', () => {
  const state = freshGame(2);
  setSnake(state, 0, [[5, 5], [6, 5], [7, 5]], [-1, 0]); // хвост (7,5) освобождается
  setSnake(state, 1, [[7, 6], [7, 7], [7, 8]], [0, -1]); // едет в (7,5)
  finishCountdown(state);
  const res = step(state);
  assert.equal(state.snakes[0].alive, true);
  assert.equal(state.snakes[1].alive, true);
  assert.deepEqual(head(state.snakes[1]), { x: 7, y: 5 });
  assert.ok(!res.events.some(e => e.type === 'death'));
});

test('тело погибшей становится едой (каждая вторая клетка)', () => {
  const state = freshGame(2);
  setSnake(state, 0, [[state.grid.w - 1, 10], [state.grid.w - 2, 10], [state.grid.w - 3, 10], [state.grid.w - 4, 10], [state.grid.w - 5, 10]], [1, 0]);
  setSnake(state, 1, [[5, 20], [5, 21], [5, 22]], [0, -1]);
  finishCountdown(state);
  state.food = [];
  step(state); // p1 погибает о стену
  assert.ok(state.food.some(f => f.x === state.grid.w - 2 && f.y === 10)); // индекс 1
  assert.ok(state.food.some(f => f.x === state.grid.w - 4 && f.y === 10)); // индекс 3
  assert.ok(!state.food.some(f => f.x === state.grid.w - 3 && f.y === 10)); // индекс 2 — не еда
  assert.ok(!state.food.some(f => f.x === state.grid.w - 5 && f.y === 10)); // индекс 4 — не еда
});

test('конец раунда: один выживший, winnerId = выживший', () => {
  const state = freshGame(2);
  setSnake(state, 0, [[state.grid.w - 1, 10], [state.grid.w - 2, 10], [state.grid.w - 3, 10]], [1, 0]);
  setSnake(state, 1, [[5, 20], [5, 21], [5, 22]], [0, -1]);
  finishCountdown(state);
  const res = step(state);
  assert.equal(state.status, 'ended');
  const end = res.events.find(e => e.type === 'roundEnd');
  assert.equal(end.winnerId, 'p2');
});

test('конец раунда в соло: 0 выживших, winnerId = null', () => {
  const state = freshGame(1);
  setSnake(state, 0, [[state.grid.w - 1, 10], [state.grid.w - 2, 10], [state.grid.w - 3, 10]], [1, 0]);
  finishCountdown(state);
  const res = step(state);
  assert.equal(state.status, 'ended');
  const end = res.events.find(e => e.type === 'roundEnd');
  assert.equal(end.winnerId, null);
  assert.ok(res.events.some(e => e.type === 'death' && e.playerId === 'p1'));
});

test('соло-раунд не заканчивается, пока змейка жива', () => {
  const state = freshGame(1);
  setSnake(state, 0, [[10, 10], [9, 10], [8, 10]], [1, 0]);
  finishCountdown(state);
  step(state);
  assert.equal(state.snakes[0].alive, true);
  assert.equal(state.status, 'running');
});

test('конец раунда по таймауту', () => {
  const state = freshGame(2);
  setSnake(state, 0, [[5, 5], [4, 5], [3, 5]], [1, 0]);
  setSnake(state, 1, [[30, 20], [30, 21], [30, 22]], [0, -1]);
  finishCountdown(state);
  state.roundEndsAtTick = state.tick + 1;
  const res = step(state);
  assert.equal(state.status, 'ended');
  const end = res.events.find(e => e.type === 'roundEnd');
  assert.equal(end.winnerId, null); // оба живы — победителя нет
});

test('roundEndsAtTick соответствует 3 минутам игры', () => {
  const state = freshGame(1);
  assert.equal(state.roundEndsAtTick, COUNTDOWN_STEPS + ROUND_DURATION_MS / TICK_MS);
});

test('еда дозаполняется до players + 2 (rng детерминирован)', () => {
  const rng = cyc(0, 0.5, 0.9);
  const state = createGame(mkPlayers(2), rng);
  assert.equal(state.food.length, 4);
  const seen = new Set(state.snakes.flatMap(s => s.body.map(c => c.x + ',' + c.y)));
  for (const f of state.food) assert.ok(!seen.has(f.x + ',' + f.y));
});

test('serialize: компактный формат §5', () => {
  const state = freshGame(2);
  setSnake(state, 0, [[5, 5], [4, 5], [3, 5]], [1, 0]);
  state.food = [{ x: 20, y: 20 }];
  const s0 = serialize(state);
  assert.equal(s0.status, 'countdown');
  assert.equal(s0.countdown, COUNTDOWN_SECONDS);
  assert.equal(typeof s0.t, 'number');
  assert.deepEqual(s0.grid, state.grid);
  assert.ok(Array.isArray(s0.food[0]));
  const sn = s0.snakes[0];
  assert.deepEqual(Object.keys(sn), ['id', 'alive', 'body', 'dir', 'score', 'len']);
  assert.deepEqual(sn.body[0], [5, 5]);
  assert.deepEqual(sn.dir, [1, 0]);
  finishCountdown(state);
  step(state);
  const s1 = serialize(state);
  assert.equal(s1.status, 'running');
  assert.equal(s1.countdown, null);
  assert.equal(s1.snakes[0].len, 3);
});

test('serialize: мёртвой змейке — body: [] и len = финальная длина, живой — тело есть', () => {
  const state = freshGame(2);
  setSnake(state, 0, [[state.grid.w - 1, 10], [state.grid.w - 2, 10], [state.grid.w - 3, 10]], [1, 0]);
  setSnake(state, 1, [[5, 20], [5, 21], [5, 22]], [0, -1]);
  finishCountdown(state);
  step(state); // p1 погибает о стену, p2 жив
  const s = serialize(state);
  const dead = s.snakes.find(x => x.id === 'p1');
  const alive = s.snakes.find(x => x.id === 'p2');
  assert.equal(dead.alive, false);
  assert.deepEqual(dead.body, []);
  assert.ok(dead.len >= 3); // длина на момент смерти сохранена для таблицы итогов
  assert.equal(dead.len, state.snakes[0].body.length);
  assert.equal(alive.alive, true);
  assert.ok(alive.body.length > 0);
});

test('createGame: пустой список игроков бросает Error', () => {
  assert.throws(() => createGame([], cyc(0.99)), /нужен хотя бы один игрок/);
});
