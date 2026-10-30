# HANDOFF — Этап 6 (финал): деплой, документация, доводка

## Статус
Все 6 этапов выполнены. Тесты логики: 21/21. Smoke: OK. Abuse: 12/12.
HTTP-статика: 200 для /, index.html, style.css, client.js, render.js; 404 для несуществующего.

## Файлы
```
Dockerfile              node:20-alpine, npm ci --omit=dev, EXPOSE 3000, CMD npm start
.dockerignore           node_modules, .npm-cache, snake-prompts, scripts, test, *.md (!README.md), логи
README.md               на русском: правила, запуск, локальная сеть, Render/Fly.io, тесты, Docker, идеи
package.json            type:module, deps: ws, scripts: start/test; package-lock.json — на месте
server/                 index.js (HTTP+WS, rate limit, heartbeat) · rooms.js · game.js · config.js · validate.js
public/                 index.html · style.css · client.js · render.js
scripts/                smoke.js · abuse.js
test/game.test.js       21/21
PROTOCOL.md             контракт сообщений
ARCHITECTURE.md         архитектура и критерии приёмки
```

## Этап 6 — что сделано
1. **Dockerfile + .dockerignore**: `node:20-alpine`, production-only (`npm ci --omit=dev`,
   `NODE_ENV=production`), `EXPOSE 3000`, `CMD ["npm","start"]`. Lock-файл существует
   и содержит ws@8.22.0 — сборка воспроизводима.
2. **wss за HTTPS-прокси**: ничего менять не потребовалось. Клиент выбирает
   `wss://` при `https:` странице (client.js, makeWs); сервер слушает
   `0.0.0.0:PORT` (`PORT` из env, default 3000). За Render/Fly TLS-прокси
   (заголовки X-Forwarded-*) ws-библиотека работает сама.
3. **README.md**: описание игры и правил, локальный запуск, игра в одной сети
   (ipconfig/ip a, открытие порта, ссылка `/?room=CODE`), деплой на Render
   (build `npm ci --omit=dev`, start `npm start`) и Fly.io (`fly launch/deploy`,
   internal_port 3000) по шагам, ссылки на PROTOCOL.md, команды тестов,
   идеи на будущее (бонусы, чат, мобильное управление).
4. **Фикс reconnect (client.js, onWsClose)**: переподключение теперь ТОЛЬКО если
   идёт раунд (`latestState.status === 'running' || 'countdown'`). В лобби/итогах
   сервер удаляет игрока сразу — клиент показывает «Соединение потеряно», сбрасывает
   myId/hostId/players/sessionToken/inRoom и возвращает в меню. Раньше клиент
   молча висел на ретраях, которым сервер отвечал `no_session`.
5. **Логи**: per-tick отладочных `console.log` в коде не было (в серверных файлах —
   только стартовый лог и `console.error` в catch; в public — вообще нет).
   Скрипты smoke/abuse логируют свои результаты — это их вывод, не мусор.

## Запуск и проверка
- Сервер: `npm install && npm start` → http://localhost:3000
- Тесты: `node test/game.test.js` (21/21; `npm test` в песочнице DSH падает
  с EPERM на spawn — запускать файл напрямую).
- С сервером в фоне: `node scripts/smoke.js` → OK; `node scripts/abuse.js` → 12/12.
- Docker: `docker build -t neon-snake . && docker run -p 3000:3000 neon-snake`.

## Ручная проверка (браузер)
1. Две вкладки: создать комнату → второй вкладкой войти по коду/ссылке → сыграть
   раунд до итогов. Плавность, эффекты (частицы смерти, тряска, пульс еды).
2. Вторая вкладка во время раунда: Network → Offline 3-5 с → «Переподключение…»
   → возврат в игру. В лобби — после оффлайна «Соединение потеряно» и меню.
3. Offline >15 с → «Соединение потеряно. Перезагрузите страницу».
4. Играбельность при искусственной задержке ~100 мс (интерполяция).
5. Деплой: собрать образ/задеплоить на Render/Fly.io и сыграть раунд по HTTPS.

## Известные проблемы
- Нет. Из критериев §7 остались только пункты, требующие живого браузера
  и реального деплоя (две вкладки, плавность при ~100 мс).

## Идеи на будущее
- Бонусы (ускорение, двойные очки) — события в game.js расширяемы.
- Чат в лобби, мобильное управление (свайпы), зрители, лидерборды,
  настройки раунда (длительность, скорость тика).
