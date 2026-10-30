// Все константы проекта — строго по ARCHITECTURE.md §3.1
export const TICK_RATE = 10;                 // тиков в секунду
export const TICK_MS = 1000 / TICK_RATE;     // 100
export const FIELD_SIZES = [ [40,30], [46,34], [52,38], [56,42], [60,44], [62,46], [64,48], [64,48] ]; // индекс = players-1
export const START_LENGTH = 3;
export const FOOD_POINTS = 10;
export const ROUND_DURATION_MS = 3 * 60 * 1000; // 180000
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // без 0/O/1/I/L
export const ROOM_CODE_LENGTH = 5;
export const MAX_PLAYERS = 8;
export const FOOD_PER_PLAYER = 2;            // еды = игроков + 2
export const INPUT_QUEUE_LEN = 2;
export const COUNTDOWN_SECONDS = 3;
export const EMPTY_ROOM_TTL_MS = 60 * 1000;
export const RECONNECT_WINDOW_MS = 15 * 1000;
export const RATE_LIMIT_PER_SEC = 30;
export const MAX_MESSAGE_BYTES = 1024;
export const NICK_MIN = 1;
export const NICK_MAX = 16;
export const COLORS = [ // 8 уникальных неоновых hex
  '#00FFFF', // циан
  '#FF00FF', // маджента
  '#39FF14', // неоново-зелёный
  '#FF073A', // неоново-красный
  '#FFF01F', // неоново-жёлтый
  '#FF8C00', // неоново-оранжевый
  '#4D4DFF', // неоново-синий
  '#BF00FF', // фиолетовый
];
