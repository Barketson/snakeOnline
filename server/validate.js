// Валидация схем входящих сообщений — ARCHITECTURE.md §4.5
// Одна функция validateMessage: тип + поля; невалидное -> ProtocolError('bad_request').
// Размер сообщения ограничен в index.js (MAX_MESSAGE_BYTES) до этой точки.
import { NICK_MIN, NICK_MAX, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './config.js';

export class ProtocolError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const bad = message => { throw new ProtocolError('bad_request', message); };

export function isValidDir(dir) {
  return Array.isArray(dir) && dir.length === 2
    && dir.every(v => Number.isInteger(v) && v >= -1 && v <= 1)
    && Math.abs(dir[0]) + Math.abs(dir[1]) === 1;
}

// Ник: строка, 1..NICK_MAX после trim, без управляющих символов
function validNick(name) {
  if (typeof name !== 'string') return false;
  const t = name.trim();
  return t.length >= NICK_MIN && t.length <= NICK_MAX && !/[\x00-\x1F\x7F]/.test(t);
}

const CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

// Схемы: проверяют и нормализуют поля; бросают ProtocolError при невалидности
const schemas = {
  create_room: m => {
    if (!validNick(m.name)) bad('ник: строка 1..16 без управляющих символов');
  },
  join_room: m => {
    if (!validNick(m.name)) bad('ник: строка 1..16 без управляющих символов');
    m.code = String(m.code ?? '').toUpperCase(); // регистронезависимо на приёме
    if (!CODE_RE.test(m.code)) bad('код комнаты: 5 символов из алфавита');
  },
  start_game: () => {},
  input: m => {
    if (!isValidDir(m.dir)) bad('dir: [dx,dy], |dx|+|dy|===1');
  },
  leave: () => {},
  reconnect: m => {
    if (typeof m.sessionToken !== 'string' || m.sessionToken.length === 0) {
      bad('sessionToken: непустая строка');
    }
  },
  ping: () => {},
};

export function validateMessage(msg) {
  const check = schemas[msg.type];
  if (!check) throw new ProtocolError('bad_request', 'неизвестный тип сообщения');
  check(msg);
  return msg;
}
