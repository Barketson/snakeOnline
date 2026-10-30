// Комнаты, лобби, игровой цикл, отключения/переподключение — ARCHITECTURE.md §3.3
import { randomUUID } from 'node:crypto';
import { createGame, step, queueInput, serialize } from './game.js';
import {
  TICK_MS, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, MAX_PLAYERS,
  COLORS, EMPTY_ROOM_TTL_MS, RECONNECT_WINDOW_MS,
} from './config.js';
import { validateMessage, ProtocolError } from './validate.js';

export { ProtocolError }; // для index.js (реэкспорт, чтобы импорты не менять)

const rooms = new Map();   // code -> room
const clients = new Map(); // ws -> { roomCode, playerId }
const tokens = new Map();  // sessionToken -> { roomCode, playerId } — reconnect

// ---------- helpers ----------
function genCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code; // без коллизий
  }
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function lobbyInfo(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, color: p.color, isHost: p.id === room.hostId,
    })),
  };
}

// null-safe: отключённый в окне переподключения (ws === null) просто пропускается
function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(data);
  }
}

// ---------- комната ----------
function makeRoom() {
  return {
    code: genCode(),
    players: new Map(),      // id -> player, порядок Map = порядок входа
    hostId: null,            // первый вошедший; при выходе — следующий по порядку
    game: null,              // внутреннее состояние раунда (game.js) или null
    participants: new Set(), // id участников текущего раунда (зрители не входят)
    timer: null,             // setInterval игрового цикла
    lastCountdown: null,
    emptyTimer: null,        // таймер удаления пустой комнаты
    sessionScore: new Map(), // id -> { id, name, color, total } — счёт за сессию
  };
}

function scoreEntry(room, p) {
  let e = room.sessionScore.get(p.id);
  if (!e) { e = { id: p.id, name: p.name, color: p.color, total: 0 }; room.sessionScore.set(p.id, e); }
  return e;
}

// Первый свободный цвет из COLORS: гарантированно уникален среди текущих
// игроков комнаты. При MAX_PLAYERS <= COLORS.length свободный цвет всегда есть.
function pickColor(room) {
  const used = new Set([...room.players.values()].map(p => p.color));
  for (const color of COLORS) if (!used.has(color)) return color;
  let n = room.players.size; // fallback (не должен случаться)
  for (;;) {
    const c = `#${((n * 0x9E3779) & 0xFFFFFF).toString(16).padStart(6, '0')}`;
    if (!used.has(c)) return c;
    n++;
  }
}

function addPlayer(room, name, ws) {
  const player = {
    id: randomUUID(),
    name: name.trim(),
    color: pickColor(room),
    sessionToken: randomUUID(), // для reconnect
    ws,                        // null — отключён в окне переподключения
    reconnectTimer: null,       // таймер окончательного удаления после разрыва
  };
  room.players.set(player.id, player);
  scoreEntry(room, player);
  if (room.hostId === null) room.hostId = player.id;
  clearTimeout(room.emptyTimer);
  room.emptyTimer = null;
  tokens.set(player.sessionToken, { roomCode: room.code, playerId: player.id });
  clients.set(ws, { roomCode: room.code, playerId: player.id });
  return player;
}

function join(ws, room, name) {
  const player = addPlayer(room, name, ws);
  send(ws, {
    type: 'room_joined',
    code: room.code,
    playerId: player.id,
    sessionToken: player.sessionToken,
    hostId: room.hostId,
    players: lobbyInfo(room).players,
  });
  broadcast(room, { type: 'lobby_update', ...lobbyInfo(room) });
}

// ---------- игровой цикл ----------
function startRound(room) {
  const players = [...room.players.values()];
  room.game = createGame(
    players.map(p => ({ id: p.id, name: p.name, color: p.color })),
    Math.random,
  );
  room.participants = new Set(players.map(p => p.id));
  room.lastCountdown = null;
  room.timer = setInterval(() => tick(room), TICK_MS);
}

function stopRound(room) {
  clearInterval(room.timer);
  room.timer = null;
  room.game = null;
  room.participants = new Set();
}

function tick(room) {
  try {
    const { events } = step(room.game);
    const s = serialize(room.game);
    if (s.countdown !== null && s.countdown !== room.lastCountdown) {
      room.lastCountdown = s.countdown;
      broadcast(room, { type: 'countdown', n: s.countdown }); // 3, 2, 1
    }
    const msLeft = room.game.status === 'running'
      ? (room.game.roundEndsAtTick - room.game.tick) * TICK_MS
      : null;
    broadcast(room, { type: 'state', ...s, msLeft });
    if (events.some(e => e.type === 'roundEnd')) endRound(room);
  } catch (err) {
    console.error(`[rooms] тик ${room.code}:`, err); // не роняем сервер/другие комнаты
    stopRound(room);
  }
}

function endRound(room) {
  const g = room.game;
  stopRound(room);
  const results = g.snakes.slice().sort((a, b) => b.score - a.score).map((sn, i) => {
    scoreEntry(room, sn).total += sn.score; // общий счёт за сессию
    return { id: sn.id, name: sn.name, color: sn.color, score: sn.score, len: sn.body.length, place: i + 1 };
  });
  const sessionScore = [...room.sessionScore.values()]
    .sort((a, b) => b.total - a.total)
    .map(e => ({ id: e.id, name: e.name, color: e.color, total: e.total }));
  broadcast(room, { type: 'round_end', results, sessionScore });
  broadcast(room, { type: 'lobby_update', ...lobbyInfo(room) }); // все в лобби
}

// ---------- выход/разрыв ----------
// Окончательное удаление игрока: токен, хост, пустая комната, lobby_update
function removePlayer(room, playerId) {
  const player = room.players.get(playerId);
  if (!player) return;
  tokens.delete(player.sessionToken);
  room.players.delete(playerId);
  if (room.hostId === playerId) {
    room.hostId = room.players.size > 0 ? [...room.players.keys()][0] : null;
  }
  if (room.players.size === 0) {
    stopRound(room);
    room.hostId = null;
    room.emptyTimer = setTimeout(() => rooms.delete(room.code), EMPTY_ROOM_TTL_MS);
    return;
  }
  // lobby_update только вне раунда: во время раунда не дёргаем игроков
  // на экран лобби, смена состава отразится в round_end (там endRound
  // уже рассылает lobby_update)
  if (!room.game) broadcast(room, { type: 'lobby_update', ...lobbyInfo(room) });
}

function disconnect(ws) {
  const c = clients.get(ws);
  if (!c) return;
  clients.delete(ws);
  const room = rooms.get(c.roomCode);
  if (!room) return;
  const player = room.players.get(c.playerId);
  if (!player || player.ws !== ws) return; // уже переподключился с нового сокета
  if (room.game) {
    // разрыв ВО ВРЕМЯ РАУНДА: не удаляем — игрок остаётся, змейка едет прямо,
    // окно RECONNECT_WINDOW_MS на переподключение, потом удаление
    player.ws = null;
    player.reconnectTimer = setTimeout(() => {
      player.reconnectTimer = null;
      removePlayer(room, player.id);
    }, RECONNECT_WINDOW_MS);
  } else {
    removePlayer(room, player.id); // разрыв В ЛОББИ: удаление сразу
  }
}

function leave(ws) { // явный leave — всегда немедленное удаление
  const c = clients.get(ws);
  if (!c) return;
  clients.delete(ws);
  const room = rooms.get(c.roomCode);
  if (!room) return;
  const player = room.players.get(c.playerId);
  if (player && player.reconnectTimer) clearTimeout(player.reconnectTimer);
  removePlayer(room, c.playerId);
}

function reconnect(ws, sessionToken) {
  if (clients.has(ws)) throw new ProtocolError('bad_request', 'вы уже в комнате');
  const ref = tokens.get(sessionToken);
  const room = ref && rooms.get(ref.roomCode);
  const player = room && room.players.get(ref.playerId);
  // не найден / вышел из окна / уже подключён (живой сокет) — одна ошибка
  if (!player || (player.ws && player.ws.readyState === 1)) {
    throw new ProtocolError('no_session', 'сессия не найдена, истекла или уже подключена');
  }
  if (player.ws) clients.delete(player.ws); // старый полуоткрытый сокет
  clearTimeout(player.reconnectTimer);
  player.reconnectTimer = null;
  player.ws = ws;
  clients.set(ws, { roomCode: room.code, playerId: player.id });
  // ресинхронизация: текущий состав, дальше клиент получит следующий state
  send(ws, {
    type: 'room_joined',
    code: room.code,
    playerId: player.id,
    sessionToken: player.sessionToken,
    hostId: room.hostId,
    players: lobbyInfo(room).players,
  });
}

// ---------- публичный API (маршрутизация из index.js) ----------
export function handleMessage(ws, msg) {
  validateMessage(msg); // единая схема валидации: тип + поля
  switch (msg.type) {
    case 'ping':
      send(ws, { type: 'pong' });
      return;
    case 'create_room': {
      if (clients.has(ws)) throw new ProtocolError('bad_request', 'вы уже в комнате');
      const room = makeRoom();
      rooms.set(room.code, room);
      join(ws, room, msg.name);
      return;
    }
    case 'join_room': {
      if (clients.has(ws)) throw new ProtocolError('bad_request', 'вы уже в комнате');
      const room = rooms.get(msg.code);
      if (!room) throw new ProtocolError('no_room', 'комната не найдена');
      if (room.players.size >= MAX_PLAYERS) throw new ProtocolError('room_full', 'комната заполнена (макс. 8)');
      join(ws, room, msg.name);
      return;
    }
    case 'start_game': {
      const c = clients.get(ws);
      if (!c) throw new ProtocolError('not_in_room', 'сначала создайте или войдите в комнату');
      const room = rooms.get(c.roomCode);
      if (c.playerId !== room.hostId) throw new ProtocolError('not_host', 'раунд запускает хост');
      if (room.game) throw new ProtocolError('already_running', 'раунд уже идёт');
      startRound(room);
      return;
    }
    case 'input': {
      const c = clients.get(ws);
      if (!c) return;
      const room = rooms.get(c.roomCode);
      if (!room || !room.game || !room.participants.has(c.playerId)) return; // зритель/лобби — игнор
      queueInput(room.game, c.playerId, { x: msg.dir[0], y: msg.dir[1] });
      return;
    }
    case 'leave':
      leave(ws);
      return;
    case 'reconnect':
      reconnect(ws, msg.sessionToken);
      return;
  }
}

export function handleClose(ws) {
  try { disconnect(ws); } catch (err) { console.error('[rooms] close:', err); }
}
