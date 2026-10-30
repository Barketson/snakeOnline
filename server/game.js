// Чистая игровая логика — без сети, сокетов и таймеров. Контракт: ARCHITECTURE.md §3.2
import {
  TICK_RATE, FIELD_SIZES, START_LENGTH, FOOD_POINTS,
  ROUND_DURATION_MS, TICK_MS, FOOD_PER_PLAYER, INPUT_QUEUE_LEN, COUNTDOWN_SECONDS,
} from './config.js';

const key = (x, y) => x + ',' + y;
const opposite = (a, b) => a.x === -b.x && a.y === -b.y;

export function createGame(players, rng) {
  if (!Array.isArray(players) || players.length === 0) {
    throw new Error('createGame: нужен хотя бы один игрок');
  }
  const n = players.length;
  const [w, h] = FIELD_SIZES[Math.min(n, FIELD_SIZES.length) - 1];
  const snakes = players.map((p, i) => {
    const angle = (2 * Math.PI * i) / n;
    const hx = Math.max(4, Math.min(w - 5, Math.round(w / 2 + (w / 4) * Math.cos(angle))));
    const hy = Math.max(4, Math.min(h - 5, Math.round(h / 2 + (h / 4) * Math.sin(angle))));
    const dir = Math.abs(w / 2 - hx) >= Math.abs(h / 2 - hy)
      ? { x: Math.sign(w / 2 - hx) || 1, y: 0 }
      : { x: 0, y: Math.sign(h / 2 - hy) || 1 };
    const body = [];
    for (let k = 0; k < START_LENGTH; k++) body.push({ x: hx - dir.x * k, y: hy - dir.y * k });
    return { id: p.id, name: p.name, color: p.color, body, dir, alive: true,
             score: 0, pendingGrowth: 0, inputQueue: [] };
  });
  const state = {
    grid: { w, h },
    tick: 0,
    status: 'countdown',
    countdownTicks: COUNTDOWN_SECONDS * TICK_RATE,
    snakes,
    food: [],
    roundEndsAtTick: COUNTDOWN_SECONDS * TICK_RATE + ROUND_DURATION_MS / TICK_MS,
    rng,
  };
  refillFood(state);
  return state;
}

export function queueInput(state, playerId, dir) {
  const snake = state.snakes.find(s => s.id === playerId);
  if (!snake || !snake.alive || state.status === 'ended') return;
  if (!dir || ![ -1, 0, 1 ].includes(dir.x) || ![ -1, 0, 1 ].includes(dir.y)) return;
  if (Math.abs(dir.x) + Math.abs(dir.y) !== 1) return;
  const eff = snake.inputQueue.length ? snake.inputQueue[snake.inputQueue.length - 1] : snake.dir;
  if ((dir.x === eff.x && dir.y === eff.y) || opposite(dir, eff)) return; // бесшумный игнор
  if (snake.inputQueue.length >= INPUT_QUEUE_LEN) return;
  snake.inputQueue.push({ x: dir.x, y: dir.y });
}

export function step(state) {
  const events = [];
  state.tick++;
  if (state.status === 'ended') return { state, events };
  if (state.status === 'countdown') {
    state.countdownTicks--;
    if (state.countdownTicks <= 0) { state.countdownTicks = 0; state.status = 'running'; }
    return { state, events };
  }

  const alive = state.snakes.filter(s => s.alive);
  // 1–2. Новые головы (по одному вводу из очереди) и факт роста в этом тике
  const plans = alive.map(s => {
    const dir = s.inputQueue.length ? s.inputQueue.shift() : s.dir;
    s.dir = dir;
    const head = s.body[0];
    return { s, head, newHead: { x: head.x + dir.x, y: head.y + dir.y }, growing: s.pendingGrowth > 0 };
  });

  // 3. Занятые клетки: тела минус голова (всегда уходит) минус хвост нерастущих (освобождён).
  //    У растущей змейки старая голова остаётся телом (body[1]), хвост — занят.
  const occupied = new Set();
  const ownCells = new Map();
  for (const p of plans) {
    const own = new Set();
    const body = p.s.body;
    for (let i = 1; i < body.length; i++) {
      if (!p.growing && i === body.length - 1) continue; // освобождённый хвост
      own.add(key(body[i].x, body[i].y));
    }
    ownCells.set(p.s, own);
    for (const k of own) occupied.add(k);
  }

  // 4. Столкновения
  const dead = new Map(); // snake -> reason
  for (const p of plans) {
    const { x, y } = p.newHead;
    if (x < 0 || y < 0 || x >= state.grid.w || y >= state.grid.h) dead.set(p.s, 'wall');
  }
  const byCell = new Map();
  for (const p of plans) {
    if (dead.has(p.s)) continue;
    const k = key(p.newHead.x, p.newHead.y);
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k).push(p);
  }
  for (const group of byCell.values()) {
    if (group.length > 1) for (const p of group) dead.set(p.s, 'head'); // лоб в лоб в одной клетке
  }
  for (let i = 0; i < plans.length; i++) { // обмен клетками за тик
    for (let j = i + 1; j < plans.length; j++) {
      const a = plans[i], b = plans[j];
      if (dead.has(a.s) || dead.has(b.s)) continue;
      if (key(a.newHead.x, a.newHead.y) === key(b.head.x, b.head.y) &&
          key(b.newHead.x, b.newHead.y) === key(a.head.x, a.head.y)) {
        dead.set(a.s, 'head');
        dead.set(b.s, 'head');
      }
    }
  }
  for (const p of plans) { // тела (своё / чужое)
    if (dead.has(p.s)) continue;
    const k = key(p.newHead.x, p.newHead.y);
    if (occupied.has(k)) dead.set(p.s, ownCells.get(p.s).has(k) ? 'self' : 'other');
  }

  // Применение движения выживших
  for (const p of plans) {
    if (dead.has(p.s)) continue;
    p.s.body.unshift(p.newHead);
    if (p.growing) p.s.pendingGrowth--;
    else p.s.body.pop();
  }

  // 5. Еда (только выжившие)
  for (const p of plans) {
    if (dead.has(p.s)) continue;
    const k = key(p.newHead.x, p.newHead.y);
    const idx = state.food.findIndex(f => key(f.x, f.y) === k);
    if (idx >= 0) {
      state.food.splice(idx, 1);
      p.s.score += FOOD_POINTS;
      p.s.pendingGrowth += 1;
      events.push({ type: 'eat', playerId: p.s.id });
    }
  }

  // 6. Смерти: тело погибшей -> еда (каждая вторая клетка, индексы 1,3,5…)
  for (const p of plans) {
    if (!dead.has(p.s)) continue;
    p.s.alive = false;
    events.push({ type: 'death', playerId: p.s.id, reason: dead.get(p.s) });
    for (let i = 1; i < p.s.body.length; i += 2) state.food.push({ ...p.s.body[i] });
  }
  refillFood(state);

  // 7. Конец раунда: ≤1 выживший (в соло — 0) или таймаут
  const aliveCount = state.snakes.filter(s => s.alive).length;
  const timeout = state.tick >= state.roundEndsAtTick;
  if (aliveCount === 0 || (state.snakes.length > 1 && aliveCount === 1) || timeout) {
    state.status = 'ended';
    const last = state.snakes.find(s => s.alive);
    events.push({ type: 'roundEnd', winnerId: aliveCount === 1 && last ? last.id : null });
  }
  return { state, events };
}

export function serialize(state) {
  return {
    t: state.tick,
    grid: { w: state.grid.w, h: state.grid.h },
    status: state.status,
    countdown: state.status === 'countdown' ? Math.ceil(state.countdownTicks / TICK_RATE) : null,
    food: state.food.map(f => [f.x, f.y]),
    snakes: state.snakes.map(s => ({
      id: s.id,
      alive: s.alive,
      body: s.alive ? s.body.map(c => [c.x, c.y]) : [],
      dir: [s.dir.x, s.dir.y],
      score: s.score,
      len: s.body.length,
    })),
  };
}

function refillFood(state) {
  const target = state.snakes.length + FOOD_PER_PLAYER;
  const taken = new Set();
  for (const s of state.snakes) if (s.alive) for (const c of s.body) taken.add(key(c.x, c.y));
  for (const f of state.food) taken.add(key(f.x, f.y));
  const free = [];
  for (let x = 0; x < state.grid.w; x++) {
    for (let y = 0; y < state.grid.h; y++) if (!taken.has(key(x, y))) free.push({ x, y });
  }
  while (state.food.length < target && free.length) {
    const i = Math.floor(state.rng() * free.length);
    state.food.push(free.splice(i, 1)[0]);
  }
}
