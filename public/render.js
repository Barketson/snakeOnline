// render.js — неоновый рендер: rAF-цикл, интерполяция, частицы, тряска, DPR (этап 4)
const TICK_MS_GUESS = 100; // ожидаемый интервал тиков (TICK_MS), только для расчёта альфы
const MAX_SKIP_TICKS = 2;  // если t прыгнул сильнее — интерполяцию пропускаем
const SELF_MARKER_MS = 3000; // подсветка своей головы в первые ~3 сек раунда
const SHAKE_AMP = 5;       // максимальное смещение экрана при тряске

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');

  function roundRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  // два последних состояния для интерполяции
  let prev = null, curr = null;
  let prevAt = 0, currAt = 0;
  let shown = null;      // последнее нарисованное состояние (для resize без новых данных)
  let myId = null, colorOf = () => '#888888';
  let roundStamp = 0;    // временная метка старта текущего раунда
  let dpr = 1;
  const particles = [];  // живые частицы смерти
  let shakeUntil = 0, shakeAt = 0;
  let running = false;

  function push(state, me, colorFn) {
    if (curr && (state.t < curr.t || state.grid.w !== curr.grid.w || state.grid.h !== curr.grid.h)) {
      prev = null; // новый раунд или смена поля — без интерполяции
    }
    prev = curr; prevAt = currAt;
    curr = state; currAt = performance.now();
    shown = state;
    myId = me; colorOf = colorFn;
    if (!prev || state.t <= prev.t) roundStamp = currAt; // t не растёт = новый раунд
    detectDeaths();
    resize(state);
    if (!running) { running = true; requestAnimationFrame(frame); }
  }

  // распад змейки на частицы + тряска при своей смерти
  function detectDeaths() {
    if (!prev) return;
    for (const s of curr.snakes) {
      const was = findSnake(prev, s.id);
      if (!was || !was.alive || s.alive) continue; // только переход alive -> dead
      const color = colorOf(s.id);
      for (let i = 0; i < was.body.length; i++) spawnBurst(was.body[i], color, i === 0 ? 6 : 2);
      if (s.id === myId) { shakeAt = currAt; shakeUntil = currAt + 500; }
    }
  }

  function spawnBurst(cell, color, n) {
    if (!curr) return;
    const cw = canvas.width / curr.grid.w, ch = canvas.height / curr.grid.h;
    const px = cell[0] * cw + cw / 2, py = cell[1] * ch + ch / 2;
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, sp = 40 + Math.random() * 140;
      particles.push({ x: px, y: py, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 600 + Math.random() * 500, t0: performance.now(), color });
    }
  }

  function resize(state) {
    const box = canvas.parentElement;
    const gw = state.grid.w, gh = state.grid.h;
    const availW = box.clientWidth || 640, availH = box.clientHeight || 480;
    const scale = Math.min(availW / gw, availH / gh);
    dpr = window.devicePixelRatio || 1;
    canvas.style.width = Math.floor(gw * scale) + 'px';
    canvas.style.height = Math.floor(gh * scale) + 'px';
    canvas.width = Math.max(1, Math.floor(gw * scale * dpr));
    canvas.height = Math.max(1, Math.floor(gh * scale * dpr));
  }

  function frame(now) {
    draw(now);
    requestAnimationFrame(frame);
  }

  function draw(now) {
    if (!shown) return;
    const w = shown.grid.w, h = shown.grid.h;
    const cw = canvas.width / w, ch = canvas.height / h;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // тряска экрана (translate в физпикселях — масштаб уже заложен в canvas.width)
    if (now < shakeUntil) {
      const decay = 1 - (now - shakeAt) / 500;
      const amp = SHAKE_AMP * dpr * decay;
      ctx.translate((Math.random() * 2 - 1) * amp, (Math.random() * 2 - 1) * amp);
    }

    // фон
    ctx.fillStyle = '#04050a';
    ctx.fillRect(-16, -16, canvas.width + 32, canvas.height + 32);

    // едва заметная сетка
    ctx.strokeStyle = 'rgba(120,180,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 1; x < w; x++) { ctx.moveTo(x * cw + 0.5, 0); ctx.lineTo(x * cw + 0.5, canvas.height); }
    for (let y = 1; y < h; y++) { ctx.moveTo(0, y * ch + 0.5); ctx.lineTo(canvas.width, y * ch + 0.5); }
    ctx.stroke();

    drawFood(now);
    drawSnakes(now);
    drawParticles(now);
  }

  function drawFood(now) {
    const cw = canvas.width / shown.grid.w, ch = canvas.height / shown.grid.h;
    const pulse = 0.5 + 0.5 * Math.sin(now / 170); // пульс радиуса и яркости
    ctx.shadowColor = '#ff5f8f';
    ctx.shadowBlur = (6 + 10 * pulse) * dpr;
    ctx.fillStyle = `rgba(255,95,143,${(0.65 + 0.35 * pulse).toFixed(3)})`;
    for (const [fx, fy] of shown.food) {
      ctx.beginPath();
      ctx.arc(fx * cw + cw / 2, fy * ch + ch / 2, Math.min(cw, ch) * (0.24 + 0.10 * pulse), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  function drawSnakes(now) {
    const w = shown.grid.w, h = shown.grid.h;
    const cw = canvas.width / w, ch = canvas.height / h;
    const alpha = interpAlpha(now);
    const markOwn = now - roundStamp < SELF_MARKER_MS;

    for (const snake of shown.snakes) {
      if (!snake.alive) continue;
      const prevSnake = alpha > 0 ? findSnake(prev, snake.id) : null;
      const color = colorOf(snake.id);
      const cells = snake.body.length;

      // тело: от хвоста к голове, интерполяция каждого сегмента
      for (let i = cells - 1; i >= 1; i--) {
        const a = segPos(snake, prevSnake, i, alpha, w, h);
        const fade = 1 - (i / cells) * 0.45; // к хвосту темнее
        ctx.fillStyle = rgba(color, 0.5 * fade);
        roundRect(a.x * cw + 1, a.y * ch + 1, cw - 2, ch - 2, Math.min(cw, ch) * 0.25);
        ctx.fill();
      }

      // голова: яркая, со свечением
      const head = segPos(snake, prevSnake, 0, alpha, w, h);
      const hx = head.x * cw + cw / 2, hy = head.y * ch + ch / 2;
      ctx.shadowColor = color;
      ctx.shadowBlur = 14 * dpr;
      ctx.fillStyle = color;
      roundRect(head.x * cw + 1, head.y * ch + 1, cw - 2, ch - 2, Math.min(cw, ch) * 0.3);
      ctx.fill();
      ctx.shadowBlur = 0;

      // глаза смотрят по dir
      const [dx, dy] = snake.dir;
      const r = Math.min(cw, ch) * 0.10;
      const ex = hx + dx * cw * 0.18, ey = hy + dy * ch * 0.18;
      const px2 = -dy * cw * 0.16, py2 = dx * ch * 0.16;
      ctx.fillStyle = '#04050a';
      ctx.beginPath(); ctx.arc(ex + px2, ey + py2, r, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(ex - px2, ey - py2, r, 0, Math.PI * 2); ctx.fill();

      // маркер «я» в первые ~3 сек раунда
      if (snake.id === myId && markOwn) {
        const bob = Math.sin(now / 150) * ch * 0.08;
        const ax = hx, ay = hy - ch * 0.9 + bob;
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 8 * dpr;
        ctx.beginPath();
        ctx.moveTo(ax, ay + ch * 0.30);
        ctx.lineTo(ax - cw * 0.24, ay - ch * 0.10);
        ctx.lineTo(ax + cw * 0.24, ay - ch * 0.10);
        ctx.closePath();
        ctx.fill();
        ctx.shadowBlur = 0;
      }
    }
  }

  function drawParticles(now) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      const age = now - p.t0;
      if (age > p.life) { particles.splice(i, 1); continue; }
      const dt = 1 / 60, damp = 0.96;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= damp; p.vy *= damp;
      const k = 1 - age / p.life;
      ctx.fillStyle = rgba(p.color, 0.8 * k);
      ctx.fillRect(p.x - dpr, p.y - dpr, 2 * dpr, 2 * dpr);
    }
  }

  // альфа интерполяции; 0 — рисуем последнее состояние как есть
  function interpAlpha(now) {
    if (!prev || !curr || prev === curr) return 0;
    if (curr.t - prev.t > MAX_SKIP_TICKS) return 0; // пропущено много тиков
    const dt = Math.min(Math.max(now - currAt, 0), TICK_MS_GUESS);
    return dt / TICK_MS_GUESS;
  }

  // позиция сегмента i с учётом интерполяции; без пары в prev — без сдвига
  function segPos(snake, prevSnake, i, alpha, w, h) {
    const b = snake.body[i];
    const p = prevSnake && prevSnake.alive && prevSnake.body[i];
    if (!p || alpha === 0) return { x: b[0], y: b[1] };
    let dx = b[0] - p[0], dy = b[1] - p[1];
    if (dx > w / 2) dx -= w; else if (dx < -w / 2) dx += w; // телепорт через край
    if (dy > h / 2) dy -= h; else if (dy < -h / 2) dy += h;
    return { x: p[0] + dx * alpha, y: p[1] + dy * alpha };
  }

  return { push, resize };
}

function findSnake(state, id) {
  if (!state) return null;
  for (const s of state.snakes) if (s.id === id) return s;
  return null;
}

// hex #RRGGBB -> rgba(r,g,b,a) — строка создаётся раз на сегмент, без лишних объектов
const rgbaCache = new Map();
function rgba(hex, a) {
  const key = hex + '|' + (a * 100 | 0);
  let s = rgbaCache.get(key);
  if (!s) {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    s = `rgba(${r},${g},${b},${a.toFixed(3)})`;
    if (rgbaCache.size > 500) rgbaCache.clear();
    rgbaCache.set(key, s);
  }
  return s;
}
