// client.js — сеть, экраны, ввод (этап 3)
import { createRenderer } from './render.js';

// ---------- состояние клиента ----------
const client = {
  ws: null,
  myId: null,
  sessionToken: null, // полный reconnect — этап 5, пока просто храним
  hostId: null,
  code: null,
  players: new Map(), // id -> {name, color}
  inRoom: false,
  lastDir: null, // последнее отправленное направление [dx,dy]
};
let latestState = null; // последний state для HUD/рендера

// ---------- DOM ----------
const $ = id => document.getElementById(id);
const el = {
  screens: {
    menu: $('screen-menu'), lobby: $('screen-lobby'),
    game: $('screen-game'), results: $('screen-results'),
  },
  nick: $('nick'), roomCode: $('room-code'),
  menuError: $('menu-error'), wsStatus: $('ws-status'),
  lobbyCode: $('lobby-code'), lobbyPlayers: $('lobby-players'),
  lobbyNote: $('lobby-note'), btnStart: $('btn-start'),
  btnNextRound: $('btn-next-round'),
  hudPlayers: $('hud-players'), hudTimer: $('hud-timer'),
  countdownOverlay: $('countdown-overlay'),
};
const canvas = $('game-canvas');
const renderer = createRenderer(canvas);

// ---------- экраны ----------
function showScreen(name) {
  for (const [key, node] of Object.entries(el.screens)) {
    node.classList.toggle('active', key === name);
  }
  if (name === 'game') renderer.resize(latestState || { grid: { w: 40, h: 30 } });
}

// ---------- сеть ----------
const RECONNECT_WINDOW_MS = 15000; // как на сервере: окно на возврат по токену
let reconnectTimer = null;
let reconnectStartedAt = 0; // 0 = не переподключаемся
let reconnectDelay = 0;     // нарастающая пауза 1с, 2с, 3с...

function makeWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}`);
  client.ws = ws;
  ws.onmessage = e => onMessage(e.data);
  ws.onclose = onWsClose;
  ws.onerror = () => { el.wsStatus.textContent = 'Ошибка соединения'; };
  return ws;
}

function connect() {
  const ws = makeWs();
  ws.onopen = () => { el.wsStatus.textContent = 'Соединение установлено'; };
}

// Разрыв: переподключаемся ТОЛЬКО если идёт раунд (countdown/running) —
// в лобби сервер удаляет игрока сразу, reconnect там бессмысленен.
// myId/players/sessionToken НЕ затираем: нужны для reconnect и ресинхронизации.
function onWsClose() {
  const roundActive = latestState &&
    (latestState.status === 'running' || latestState.status === 'countdown');
  if (!client.inRoom || !client.sessionToken || !roundActive) {
    resetReconnect();
    if (client.inRoom) {
      // лобби/итоги: сервер уже удалил игрока — показываем и возвращаем в меню
      el.wsStatus.textContent = 'Соединение потеряно';
      client.inRoom = false;
      client.myId = null;
      client.sessionToken = null;
      client.hostId = null;
      client.code = null;
      client.players.clear();
      latestState = null;
      showScreen('menu');
    } else {
      el.wsStatus.textContent = 'Соединение потеряно. Перезагрузите страницу.';
    }
    return;
  }
  if (!reconnectStartedAt) {
    reconnectStartedAt = Date.now();
    showStatusInGame('Переподключение…');
  }
  reconnectDelay += 1000;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (!client.inRoom || !client.sessionToken) return; // пользователь вышел
    if (Date.now() - reconnectStartedAt >= RECONNECT_WINDOW_MS) {
      reconnectStartedAt = 0;
      reconnectDelay = 0;
      el.wsStatus.textContent = 'Соединение потеряно. Перезагрузите страницу.';
      showStatusInGame('Соединение потеряно. Перезагрузите страницу.');
      return;
    }
    const ws = makeWs();
    ws.onopen = () => {
      el.wsStatus.textContent = 'Переподключение…';
      send({ type: 'reconnect', sessionToken: client.sessionToken });
    };
  }, reconnectDelay);
}

function resetReconnect() {
  clearTimeout(reconnectTimer);
  reconnectStartedAt = 0;
  reconnectDelay = 0;
}

function send(msg) {
  if (client.ws && client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(msg));
  }
}

function showStatusInGame(text) {
  el.countdownOverlay.textContent = text;
  el.countdownOverlay.classList.remove('hidden');
}

function onMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  switch (msg.type) {
    case 'room_joined': onRoomJoined(msg); break;
    case 'lobby_update': onLobbyUpdate(msg); break;
    case 'countdown': showCountdown(msg.n); break;
    case 'state': onState(msg); break;
    case 'round_end': onRoundEnd(msg); break;
    case 'error': onError(msg); break;
    case 'pong': break;
  }
}

// ---------- сообщения ----------
function rememberPlayers(players) {
  client.players.clear();
  for (const p of players) client.players.set(p.id, { name: p.name, color: p.color });
}

function onRoomJoined(msg) {
  const wasReconnect = reconnectStartedAt > 0;
  resetReconnect();
  client.myId = msg.playerId;
  client.sessionToken = msg.sessionToken;
  client.hostId = msg.hostId;
  client.code = msg.code;
  client.inRoom = true;
  client.lastDir = null;
  rememberPlayers(msg.players);
  renderLobby(msg.players, msg.hostId);
  if (wasReconnect) {
    // ресинхронизация: остаёмся на текущем экране, следующий state продолжит игру
    el.wsStatus.textContent = 'Соединение установлено';
    el.countdownOverlay.classList.add('hidden');
  } else {
    showScreen('lobby');
  }
}

function onLobbyUpdate(msg) {
  client.hostId = msg.hostId;
  client.code = msg.code;
  rememberPlayers(msg.players);
  renderLobby(msg.players, msg.hostId);
  // смена хоста могла изменить видимость «Ещё раунд» (экран итогов)
  el.btnNextRound.style.display = client.myId === client.hostId ? '' : 'none';
  // во время раунда или на экране итогов лобби не показываем:
  // иначе выход другого игрока «выдёргивает» с игрового экрана,
  // а lobby_update после round_end мгновенно затирает итоги
  const screen = el.screens.game.classList.contains('active') ? 'game'
    : el.screens.results.classList.contains('active') ? 'results' : null;
  if (screen !== 'game' && screen !== 'results') showScreen('lobby');
}

function showCountdown(n) {
  client.lastDir = null; // новый раунд — ввод снова актуален
  showScreen('game');
  el.countdownOverlay.textContent = n;
  el.countdownOverlay.classList.remove('hidden');
}

function onState(msg) {
  latestState = msg;
  if (msg.status === 'countdown') {
    showScreen('game');
    el.countdownOverlay.textContent = msg.countdown ?? '';
    el.countdownOverlay.classList.remove('hidden');
  } else if (msg.status === 'running') {
    showScreen('game');
    el.countdownOverlay.classList.add('hidden');
  }
  renderer.push(msg, client.myId, id => (client.players.get(id)?.color) || '#888888');
  renderHud(msg);
}

function onRoundEnd(msg) {
  renderResults(msg);
  el.btnNextRound.style.display = client.myId === client.hostId ? '' : 'none';
  showScreen('results');
}

function onError(msg) {
  // окно переподключения истекло на сервере — сессию не восстановить
  if (reconnectStartedAt > 0 && msg.code === 'no_session') {
    resetReconnect();
    client.inRoom = false;
    el.wsStatus.textContent = 'Соединение потеряно. Перезагрузите страницу.';
    showStatusInGame('Соединение потеряно. Перезагрузите страницу.');
    return;
  }
  if (client.inRoom) {
    el.lobbyNote.textContent = msg.message || 'Ошибка';
  } else {
    el.menuError.textContent = msg.message || 'Ошибка';
  }
}

// ---------- отрисовка DOM (только textContent/createElement) ----------
function renderLobby(players, hostId) {
  el.lobbyCode.textContent = client.code || '';
  el.lobbyPlayers.textContent = '';
  for (const p of players) {
    const li = document.createElement('li');
    li.className = 'player-item';
    const dot = document.createElement('span');
    dot.className = 'player-dot';
    dot.style.background = p.color;
    const name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = p.name;
    li.append(dot, name);
    if (p.id === hostId) {
      const badge = document.createElement('span');
      badge.className = 'host-badge';
      badge.textContent = 'Хост';
      li.append(badge);
    }
    if (p.id === client.myId) {
      const you = document.createElement('span');
      you.className = 'you-badge';
      you.textContent = 'Вы';
      li.append(you);
    }
    el.lobbyPlayers.append(li);
  }
  el.btnStart.style.display = client.myId === hostId ? '' : 'none';
  el.lobbyNote.textContent = '';
}

function fmtTime(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function renderHud(state) {
  el.hudPlayers.textContent = '';
  for (const snake of state.snakes) {
    const info = client.players.get(snake.id);
    const div = document.createElement('div');
    div.className = 'hud-player' + (snake.alive ? '' : ' dead');
    const dot = document.createElement('span');
    dot.className = 'player-dot';
    dot.style.background = info ? info.color : '#666';
    const name = document.createElement('span');
    name.className = 'hud-player-name';
    name.textContent = info ? info.name : snake.id;
    const stats = document.createElement('span');
    stats.className = 'hud-player-stats';
    stats.textContent = `${snake.score} очк · длина ${snake.len}`;
    div.append(dot, name, stats);
    el.hudPlayers.append(div);
  }
  el.hudTimer.textContent = state.msLeft != null ? fmtTime(state.msLeft) : '--:--';
}

function makeCell(text, color) {
  const td = document.createElement('td');
  if (color != null) {
    const wrap = document.createElement('div');
    wrap.className = 'cell-player';
    const dot = document.createElement('span');
    dot.className = 'player-dot';
    dot.style.background = color;
    const span = document.createElement('span');
    span.textContent = text;
    wrap.append(dot, span);
    td.append(wrap);
  } else {
    td.textContent = text;
  }
  return td;
}

function renderResults(msg) {
  const roundBody = $('results-round');
  roundBody.textContent = '';
  for (const r of msg.results) {
    const tr = document.createElement('tr');
    tr.append(makeCell(String(r.place)), makeCell(r.name, r.color),
      makeCell(String(r.score)), makeCell(String(r.len)));
    roundBody.append(tr);
  }
  const totalBody = $('results-total');
  totalBody.textContent = '';
  for (const s of msg.sessionScore) {
    const tr = document.createElement('tr');
    tr.append(makeCell(s.name, s.color), makeCell(String(s.total)));
    totalBody.append(tr);
  }
}

// ---------- действия ----------
function readNick() {
  const name = el.nick.value.trim();
  if (!name) { el.menuError.textContent = 'Введите ник'; return null; }
  return name;
}

function doCreate() {
  const name = readNick();
  if (name) send({ type: 'create_room', name });
}

function doJoin() {
  const name = readNick();
  if (!name) return;
  const code = el.roomCode.value.trim().toUpperCase();
  if (!code) { el.menuError.textContent = 'Введите код комнаты'; return; }
  send({ type: 'join_room', code, name });
}

function doLeave() {
  send({ type: 'leave' });
  resetReconnect();
  client.inRoom = false;
  client.myId = null;
  client.sessionToken = null;
  client.hostId = null;
  client.code = null;
  client.players.clear();
  latestState = null;
  showScreen('menu');
}

async function doCopyLink() {
  if (!client.code) return;
  const url = `${location.origin}/?room=${client.code}`;
  try {
    await navigator.clipboard.writeText(url);
    el.lobbyNote.textContent = 'Ссылка скопирована';
  } catch {
    // fallback для старых браузеров / незащищённого контекста
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); el.lobbyNote.textContent = 'Ссылка скопирована'; }
    catch { el.lobbyNote.textContent = url; }
    ta.remove();
  }
}

// ---------- ввод ----------
const KEY_DIRS = {
  ArrowUp: [0, -1], KeyW: [0, -1],
  ArrowDown: [0, 1], KeyS: [0, 1],
  ArrowLeft: [-1, 0], KeyA: [-1, 0],
  ArrowRight: [1, 0], KeyD: [1, 0],
};

function onKeyDown(e) {
  if (!client.inRoom) return;
  const dir = KEY_DIRS[e.code];
  if (!dir) return;
  e.preventDefault(); // стрелки не скроллят страницу
  if (!latestState || latestState.status !== 'running') return;
  if (client.lastDir && client.lastDir[0] === dir[0] && client.lastDir[1] === dir[1]) return;
  client.lastDir = dir;
  send({ type: 'input', dir });
}

// ---------- инициализация ----------
function init() {
  $('btn-create').addEventListener('click', doCreate);
  $('btn-join').addEventListener('click', doJoin);
  el.nick.addEventListener('keydown', e => { if (e.key === 'Enter') doCreate(); });
  el.roomCode.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
  $('btn-copy-link').addEventListener('click', doCopyLink);
  el.btnStart.addEventListener('click', () => send({ type: 'start_game' }));
  el.btnNextRound.addEventListener('click', () => send({ type: 'start_game' }));
  $('btn-leave-lobby').addEventListener('click', doLeave);
  $('btn-leave-results').addEventListener('click', doLeave);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', () => {
    if (latestState) renderer.resize(latestState);
  });
  // ?room=CODE — подставить код и предложить войти
  const roomFromUrl = new URLSearchParams(location.search).get('room');
  if (roomFromUrl) {
    el.roomCode.value = roomFromUrl.toUpperCase().slice(0, 5);
    el.wsStatus.textContent = 'По ссылке есть код комнаты — введите ник и нажмите «Войти по коду»';
  }

  connect();
}

init();
