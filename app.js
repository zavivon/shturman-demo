import { Locator, Tracker } from './locate.js';

const OPENCV_URL = 'https://docs.opencv.org/4.10.0/opencv.js';
const CW = 1920, CH = 1080;                       // условный размер экрана телевизора после выпрямления
const DATA = new URLSearchParams(location.search).get('data');        // ?data=gtadb — другой набор данных
const BASE = DATA && /^[a-z0-9_-]+$/i.test(DATA) ? `assets-${DATA}/` : 'assets/';
let TYPES = { quest: 'Задания', car: 'Редкие машины', shop: 'Магазины', stash: 'Тайники', fence: 'Скупщики' };
let ICONS = { quest: 'quest', car: 'car', shop: 'shop', stash: 'stash', fence: 'fence' };
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const store = {
  get(k, d) { try { const v = localStorage.getItem('nav.' + (DATA || '') + '.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('nav.' + (DATA || '') + '.' + k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};

const S = {
  cv: null, meta: null, locator: null, tracker: null, pois: [], truth: null,
  phase: 'welcome', running: false, demo: false, mode: 'radar',
  quad: store.get('quad', [[0.08, 0.08], [0.92, 0.08], [0.92, 0.92], [0.08, 0.92]]),   // углы экрана в долях кадра камеры
  hKey: '', h: null, probe: null,
  pos: null, hdg: 0, status: 'lost', lastSeen: -1e9, lastGrab: 0, grabTime: 0, trail: [],
  full: { x: 0, y: 0, z: 1 }, follow: false,
  found: new Set(store.get('found', [])), hidden: new Set(store.get('hidden', [])),
  filters: store.get('filters', { types: {}, noSpoilers: false }),
  voice: store.get('voice', false), lastSpoke: 0, spoken: new Set(), selected: null, cardId: null,
  stats: [],
};
window.__app = S;

const video = $('cam'), stage = $('stage'), quadCanvas = $('quad'), layer = $('layer'), mapview = $('mapview'), me = $('me');
const grab = document.createElement('canvas'), gctx = grab.getContext('2d', { willReadFrequently: true });

// ---------- загрузка ----------
function loadCV() {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = OPENCV_URL; s.async = true;
    s.onerror = () => reject(new Error('не удалось загрузить OpenCV'));
    s.onload = async () => {
      let c = window.cv;
      if (c instanceof Promise) c = await c;
      const done = () => { window.cv = c; S.cv = c; resolve(); };
      if (c.Mat) done(); else c.onRuntimeInitialized = done;
    };
    document.head.appendChild(s);
  });
}

async function init() {
  try {
    const [meta, buf, pois] = await Promise.all([
      fetch(BASE + 'meta.json').then(r => r.json()),
      fetch(BASE + 'features.bin').then(r => r.arrayBuffer()),
      fetch(BASE + 'pois.json').then(r => r.json()),
      loadCV(),
    ]);
    S.meta = meta; S.pois = pois;
    if (meta.types) { TYPES = Object.fromEntries(meta.types.map(t => [t.key, t.label])); ICONS = Object.fromEntries(meta.types.map(t => [t.key, t.icon])); }
    for (const t of Object.keys(TYPES)) if (!(t in S.filters.types)) S.filters.types[t] = true;
    if (meta.attribution) $('credit').textContent = meta.attribution;
    S.locator = new Locator(S.cv, meta, buf);
    S.tracker = new Tracker(S.locator);
    S.rect = { x: Math.round(meta.minimap.x * CW), y: Math.round(meta.minimap.y * CH), w: Math.round(meta.minimap.w * CW), h: Math.round(meta.minimap.h * CH) };
    if (meta.demo) {
      S.truth = await fetch(BASE + 'demo_truth.json').then(r => r.json()).catch(() => null);
      $('btn-demo').hidden = false;
    }
    buildMap(); buildSheets();
    $('loadmsg').textContent = meta.synthetic ? 'Тестовая карта: выдуманный город, не игра.' : 'Набор данных: ' + (meta.dataset || 'свой');
    $('btn-camera').disabled = false; $('btn-demo').disabled = false;
    if (new URLSearchParams(location.search).has('demo') && meta.demo) startSource('demo');
  } catch (e) {
    console.error(e);
    $('loadmsg').textContent = 'Ошибка загрузки: ' + e.message;
  }
}

async function startSource(kind) {
  try {
    S.demo = kind === 'demo';
    if (S.demo) {
      video.srcObject = null; video.src = S.meta.demo; video.loop = true;
      S.quadSaved = S.quad; S.quad = [[0, 0], [1, 0], [1, 1], [0, 1]];
    } else {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('камера доступна только по HTTPS');
      video.srcObject = await navigator.mediaDevices.getUserMedia({
        audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    }
    await video.play();
    showSetup();
    if (!S.running) { S.running = true; loop(); }
  } catch (e) {
    console.error(e);
    $('loadmsg').textContent = 'Камера не открылась: ' + e.message;
  }
}

// ---------- настройка: рамка телевизора ----------
function showSetup() {
  S.phase = 'setup'; S.probe = null;
  $('welcome').hidden = true; $('main').hidden = true;
  $('setup').hidden = false; $('setup').classList.remove('behind');
  layoutStage();
}

function layoutStage() {
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const k = Math.min(innerWidth / vw, innerHeight / vh), dpr = devicePixelRatio || 1;
  stage.style.width = vw * k + 'px'; stage.style.height = vh * k + 'px';
  quadCanvas.width = Math.round(vw * k * dpr); quadCanvas.height = Math.round(vh * k * dpr);
  drawQuad();
}

function homography() {   // условный экран CW x CH -> пиксели кадра камеры
  const vw = video.videoWidth, vh = video.videoHeight, key = JSON.stringify(S.quad) + vw + 'x' + vh;
  if (key === S.hKey) return S.h;
  const cv = S.cv;
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, CW, 0, CW, CH, 0, CH]);
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, S.quad.flatMap(([u, v]) => [u * vw, v * vh]));
  const H = cv.getPerspectiveTransform(src, dst);
  S.h = Array.from(H.data64F); S.hKey = key;
  src.delete(); dst.delete(); H.delete();
  return S.h;
}
const applyH = (h, x, y) => { const w = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]; };
const mul3 = (a, b) => { const o = new Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]; return o; };

function drawQuad() {
  const c = quadCanvas, g = c.getContext('2d'), w = c.width, h = c.height, dpr = devicePixelRatio || 1;
  g.clearRect(0, 0, w, h);
  const pts = S.quad.map(([u, v]) => [u * w, v * h]);
  g.fillStyle = 'rgba(0,0,0,.45)';
  g.beginPath(); g.rect(0, 0, w, h); g.moveTo(...pts[0]); for (const i of [3, 2, 1]) g.lineTo(...pts[i]); g.closePath(); g.fill('evenodd');
  g.strokeStyle = '#ff3d9a'; g.lineWidth = 3 * dpr;
  g.beginPath(); g.moveTo(...pts[0]); for (const i of [1, 2, 3]) g.lineTo(...pts[i]); g.closePath(); g.stroke();
  if (!S.demo) for (const p of pts) { g.fillStyle = '#ff3d9a'; g.beginPath(); g.arc(p[0], p[1], 13 * dpr, 0, 7); g.fill(); }
  if (S.cv && video.videoWidth) {   // где приложение ждёт мини-карту
    const hm = homography(), r = S.rect, k = w / video.videoWidth;
    const mm = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(([x, y]) => applyH(hm, x, y).map(v => v * k));
    g.strokeStyle = '#3ddc84'; g.lineWidth = 2 * dpr; g.setLineDash([8 * dpr, 6 * dpr]);
    g.beginPath(); g.moveTo(...mm[0]); for (const i of [1, 2, 3]) g.lineTo(...mm[i]); g.closePath(); g.stroke(); g.setLineDash([]);
  }
}

let dragCorner = -1;
quadCanvas.addEventListener('pointerdown', e => {
  if (S.demo) return;
  const r = quadCanvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  let best = 48, idx = -1;
  S.quad.forEach(([u, v], i) => { const d = Math.hypot(u * r.width - x, v * r.height - y); if (d < best) { best = d; idx = i; } });
  dragCorner = idx;
  if (idx >= 0) quadCanvas.setPointerCapture(e.pointerId);
});
quadCanvas.addEventListener('pointermove', e => {
  if (dragCorner < 0) return;
  const r = quadCanvas.getBoundingClientRect();
  S.quad[dragCorner] = [clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)];
  drawQuad();
});
const endDrag = () => { if (dragCorner >= 0) { dragCorner = -1; store.set('quad', S.quad); } };
quadCanvas.addEventListener('pointerup', endDrag); quadCanvas.addEventListener('pointercancel', endDrag);

// ---------- кадр камеры -> выпрямленная мини-карта ----------
function grabMinimap() {
  const cv = S.cv, vw = video.videoWidth, vh = video.videoHeight, r = S.rect, h = homography();
  const cs = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(([x, y]) => applyH(h, x, y));
  const x0 = clamp(Math.floor(Math.min(...cs.map(p => p[0]))) - 2, 0, vw), x1 = clamp(Math.ceil(Math.max(...cs.map(p => p[0]))) + 2, 0, vw);
  const y0 = clamp(Math.floor(Math.min(...cs.map(p => p[1]))) - 2, 0, vh), y1 = clamp(Math.ceil(Math.max(...cs.map(p => p[1]))) + 2, 0, vh);
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < 24 || bh < 24) return null;
  grab.width = bw; grab.height = bh;
  S.grabTime = S.frameTime ?? video.currentTime;   // время именно того кадра, который сейчас на экране
  gctx.drawImage(video, x0, y0, bw, bh, 0, 0, bw, bh);     // читаем только кусок кадра с мини-картой
  const sub = cv.matFromImageData(gctx.getImageData(0, 0, bw, bh));
  const M = mul3([1, 0, -x0, 0, 1, -y0, 0, 0, 1], mul3(h, [1, 0, r.x, 0, 1, r.y, 0, 0, 1]));   // пиксель мини-карты -> пиксель куска
  const Mm = cv.matFromArray(3, 3, cv.CV_64F, M), out = new cv.Mat();
  cv.warpPerspective(sub, out, Mm, new cv.Size(r.w, r.h), cv.INTER_LINEAR | cv.WARP_INVERSE_MAP, cv.BORDER_CONSTANT, new cv.Scalar());
  sub.delete(); Mm.delete();
  return out;
}

function loop() {
  if (!S.running) return;
  const t0 = performance.now();
  let period = 500;
  try {
    if (video.readyState >= 2 && video.videoWidth && S.phase !== 'welcome') {
      const mm = grabMinimap();
      if (mm) {
        if (S.phase === 'setup') {
          S.probe = S.locator.locate(mm, null);
          S.cv.imshow($('thumb'), mm);
          $('thumb').classList.toggle('ok', !!S.probe);
          $('setup-title').textContent = S.probe ? 'Экран найден' : 'Наведи на телевизор';
        } else {
          const dt = clamp((t0 - S.lastGrab) / 1000, 0.05, 1);
          S.lastGrab = t0;
          const [status, loc] = S.tracker.update(mm, dt);
          onResult(status, loc, performance.now() - t0);
          period = 1000 / S.meta.trackFps;
        }
        mm.delete();
      }
    }
  } catch (e) { console.error(e); }
  setTimeout(loop, Math.max(40, period - (performance.now() - t0)));   // пауза нужна, чтобы браузер успел показать новый кадр видео
}

function onResult(status, loc, ms) {
  S.status = status;
  if (loc) {
    if (status === 'jump') S.trail = [];
    S.pos = [loc.x, loc.y];
    S.hdg += ((loc.angle - S.hdg + 540) % 360) - 180;   // без перескока через 0/360, иначе карта крутанётся
    S.lastSeen = performance.now();
    const last = S.trail[S.trail.length - 1];
    if (!last || Math.hypot(last[0] - loc.x, last[1] - loc.y) > 6) { S.trail.push([loc.x, loc.y]); if (S.trail.length > 500) S.trail.shift(); }
  }
  if (S.truth) {   // демо: сверяемся с известной истинной позицией
    const f = S.truth.frames[clamp(Math.round(S.grabTime * S.truth.fps), 0, S.truth.frames.length - 1)];
    S.stats.push({ status, ms, visible: f[3], err: loc ? Math.hypot(loc.x - f[0], loc.y - f[1]) : null, hdgErr: loc ? ((loc.angle - f[2] + 540) % 360) - 180 : null });
    if (S.stats.length > 2000) S.stats.shift();
  }
  render();
}

// ---------- карта ----------
function buildMap() {
  const [W, H] = S.meta.mapSize;
  layer.style.width = W + 'px'; layer.style.height = H + 'px';
  const img = $('mapimg'); img.width = W; img.height = H; img.src = BASE + 'map.svg';
  $('trail').setAttribute('width', W); $('trail').setAttribute('height', H);
  const box = $('pois');
  for (const p of S.pois) {
    const el = document.createElement('div');
    el.className = 'poi'; el.dataset.id = p.id;
    el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
    el.innerHTML = `<svg><use href="#i-${ICONS[p.type] || 'sight'}"/></svg>`;
    box.appendChild(el); p.el = el;
  }
  refreshMarkers();
}

const shown = p => S.filters.types[p.type] && !S.hidden.has(p.id) && !(S.filters.noSpoilers && p.spoiler);
function refreshMarkers() {
  for (const p of S.pois) {
    p.el.classList.toggle('off', !shown(p));
    p.el.classList.toggle('found', S.found.has(p.id));
    p.el.classList.toggle('sel', S.selected === p.id);
  }
}

function fitFull() {
  const [W, H] = S.meta.mapSize, vw = mapview.clientWidth, vh = mapview.clientHeight;
  const z = Math.min(vw / W, vh / H);
  S.full = { x: (vw - W * z) / 2, y: (vh - H * z) / 2, z };
}

function render() {
  if (S.phase !== 'run') return;
  const [W, H] = S.meta.mapSize, vw = mapview.clientWidth, vh = mapview.clientHeight;
  const p = S.pos || [W / 2, H / 2];
  let z, rot = 0, tf;
  if (S.mode === 'radar') {
    z = clamp(vh / 520, 0.45, 1.3); rot = S.hdg;   // карта поворачивается вместе с игроком, он чуть ниже центра
    tf = `translate(${vw / 2}px, ${vh * 0.62}px) rotate(${-rot}deg) scale(${z}) translate(${-p[0]}px, ${-p[1]}px)`;
  } else {
    if (S.follow && S.pos) { S.full.x = vw / 2 - p[0] * S.full.z; S.full.y = vh / 2 - p[1] * S.full.z; }
    z = S.full.z;
    tf = `translate(${S.full.x}px, ${S.full.y}px) rotate(0deg) scale(${z}) translate(0px, 0px)`;
  }
  const ms = clamp(z * 2.2, 0.34, 1);   // на общем плане значки мельче, иначе они закрывают всю карту
  layer.style.transform = tf;
  layer.style.setProperty('--inv', ms / z);
  layer.style.setProperty('--rot', rot + 'deg');
  me.style.transform = `translate(${p[0]}px, ${p[1]}px) rotate(${S.hdg}deg) scale(${Math.max(ms, 0.6) / z})`;
  me.classList.toggle('lost', S.status === 'lost');
  $('trail').firstElementChild.setAttribute('points', S.trail.map(q => q[0].toFixed(0) + ',' + q[1].toFixed(0)).join(' '));

  const st = $('status'), since = performance.now() - S.lastSeen;
  st.className = S.status !== 'lost' ? 'ok' : since < 4000 ? '' : 'bad';
  st.lastElementChild.textContent = S.status !== 'lost' ? 'Вижу карту' : since < 4000 ? 'Ищу…' : 'Не вижу мини-карту';
  updateCard();
}

// ---------- карточка и подсказки ----------
const fmtDist = px => { const m = px * S.meta.metersPerPx; return m < 1000 ? Math.max(10, Math.round(m / 10) * 10) + ' м' : (m / 1000).toFixed(1) + ' км'; };
function direction(p) {
  const rel = ((Math.atan2(p.x - S.pos[0], -(p.y - S.pos[1])) * 180 / Math.PI - S.hdg) % 360 + 540) % 360 - 180;
  return Math.abs(rel) < 30 ? 'впереди' : Math.abs(rel) > 150 ? 'сзади' : rel > 0 ? 'справа' : 'слева';
}

function updateCard() {
  let p = S.selected != null ? S.pois.find(q => q.id === S.selected) : null;
  if (p && (S.found.has(p.id) || !shown(p))) { p = null; S.selected = null; }
  if (!p && S.pos) {
    let best = Infinity;
    for (const q of S.pois) {
      if (!shown(q) || S.found.has(q.id)) continue;
      const d = Math.hypot(q.x - S.pos[0], q.y - S.pos[1]);
      if (d < best) { best = d; p = q; }
    }
  }
  const card = $('card');
  card.classList.toggle('empty', !p);
  if (!p) {
    $('card-title').textContent = S.pos ? 'Рядом ничего нет' : 'Жду позицию';
    $('card-note').textContent = S.pos ? 'Все находки с выбранными фильтрами уже отмечены.' : 'Как только увижу мини-карту, покажу ближайшую находку.';
    S.cardId = null;
    return;
  }
  if (S.cardId !== p.id) {
    S.cardId = p.id;
    $('card-title').textContent = p.title; $('card-note').textContent = p.note;
    $('card-ico').setAttribute('href', '#i-' + (ICONS[p.type] || 'sight'));
  }
  if (S.pos) {
    const d = Math.hypot(p.x - S.pos[0], p.y - S.pos[1]), dir = direction(p);
    $('card-dist').textContent = fmtDist(d); $('card-dir').textContent = dir;
    speak(p, d, dir);
  } else { $('card-dist').textContent = '—'; $('card-dir').textContent = ''; }
}

function speak(p, dist, dir) {   // не чаще раза в минуту и только о новой находке рядом
  if (!S.voice || !('speechSynthesis' in window) || S.status === 'lost') return;
  const now = Date.now();
  if (now - S.lastSpoke < 60000 || S.spoken.has(p.id) || dist * S.meta.metersPerPx > 250) return;
  S.lastSpoke = now; S.spoken.add(p.id);
  const u = new SpeechSynthesisUtterance(`${p.title}, ${fmtDist(dist).replace(' м', ' метров')} ${dir}`);
  u.lang = 'ru-RU';
  speechSynthesis.speak(u);
}

function mark(set, key) {
  if (S.cardId == null) return;
  set.add(S.cardId); store.set(key, [...set]);
  S.selected = null; S.cardId = null;
  refreshMarkers(); render();
}
$('btn-found').onclick = () => mark(S.found, 'found');
$('btn-hide').onclick = () => mark(S.hidden, 'hidden');

// ---------- шторки: фильтры и прогресс ----------
function buildSheets() {
  const box = $('type-toggles');
  for (const [t, name] of Object.entries(TYPES)) {
    const b = document.createElement('button');
    b.innerHTML = `<svg><use href="#i-${ICONS[t] || 'sight'}"/></svg>${name}`;
    b.classList.toggle('on', !!S.filters.types[t]);
    b.onclick = () => { S.filters.types[t] = !S.filters.types[t]; b.classList.toggle('on', S.filters.types[t]); saveFilters(); };
    box.appendChild(b);
  }
  const sp = $('btn-spoilers');
  sp.classList.toggle('on', S.filters.noSpoilers);
  sp.onclick = () => { S.filters.noSpoilers = !S.filters.noSpoilers; sp.classList.toggle('on', S.filters.noSpoilers); saveFilters(); };
  for (const b of document.querySelectorAll('[data-close]')) b.onclick = () => b.closest('.sheet').hidden = true;
  $('btn-voice').classList.toggle('on', S.voice);
}
function saveFilters() { store.set('filters', S.filters); refreshMarkers(); render(); }

function showProgress() {
  const bars = $('progress-bars'); bars.innerHTML = '';
  for (const [t, name] of Object.entries(TYPES)) {
    const all = S.pois.filter(p => p.type === t), n = all.filter(p => S.found.has(p.id)).length;
    bars.insertAdjacentHTML('beforeend', `<div class="row"><span>${name}</span><div class="bar"><i style="width:${all.length ? 100 * n / all.length : 0}%"></i></div><span class="n">${n} / ${all.length}</span></div>`);
  }
  const g = S.meta.grid, [W, H] = S.meta.mapSize, sec = $('progress-sectors');
  sec.style.gridTemplateColumns = `repeat(${g}, 1fr)`; sec.innerHTML = '';
  for (let r = 0; r < g; r++) for (let c = 0; c < g; c++) {
    const inside = S.pois.filter(p => Math.min(g - 1, Math.floor(p.x / W * g)) === c && Math.min(g - 1, Math.floor(p.y / H * g)) === r);
    const n = inside.filter(p => S.found.has(p.id)).length;
    sec.insertAdjacentHTML('beforeend', `<span class="${inside.length && n === inside.length ? 'full' : ''}">${'ABCDEFGHIJ'[c]}${r + 1}${inside.length ? ' · ' + n + '/' + inside.length : ''}</span>`);
  }
  $('sheet-progress').hidden = false;
}

// ---------- кнопки и жесты ----------
$('btn-camera').onclick = () => startSource('camera');
$('btn-demo').onclick = () => startSource('demo');
$('btn-start').onclick = () => {
  S.phase = 'run'; S.tracker.reset(); S.lastGrab = performance.now(); S.stats = [];
  if (S.probe) { S.tracker.pos = [S.probe.x, S.probe.y]; }
  $('setup').classList.add('behind'); $('main').hidden = false;   // видео остаётся на странице, иначе телефон перестаёт отдавать кадры
  keepAwake(); render();
};
$('btn-setup').onclick = showSetup;
$('btn-filters').onclick = () => $('sheet-filters').hidden = false;
$('btn-progress').onclick = showProgress;
$('btn-voice').onclick = () => {
  S.voice = !S.voice; store.set('voice', S.voice); $('btn-voice').classList.toggle('on', S.voice);
  if (S.voice && 'speechSynthesis' in window) { const u = new SpeechSynthesisUtterance('Голос включён'); u.lang = 'ru-RU'; speechSynthesis.speak(u); }
};
$('btn-mode').onclick = () => {
  S.mode = S.mode === 'radar' ? 'full' : 'radar';
  $('btn-mode').textContent = S.mode === 'radar' ? 'Вся карта' : 'Радар';
  $('btn-me').hidden = S.mode !== 'full';
  if (S.mode === 'full') { S.follow = false; fitFull(); }
  render();
};
$('btn-me').onclick = () => { S.follow = true; S.full.z = Math.max(S.full.z, 0.6); render(); };

function zoomAt(px, py, f) {
  const [W, H] = S.meta.mapSize, z0 = S.full.z, z1 = clamp(z0 * f, Math.min(mapview.clientWidth / W, mapview.clientHeight / H) * 0.8, 4);
  S.full.x = px - (px - S.full.x) * z1 / z0; S.full.y = py - (py - S.full.y) * z1 / z0; S.full.z = z1;
}
const ptrs = new Map();
let moved = 0;
mapview.addEventListener('pointerdown', e => {
  if (e.target.closest('#tools')) return;
  ptrs.set(e.pointerId, [e.clientX, e.clientY]); moved = 0;
  if (S.mode === 'full') { mapview.setPointerCapture(e.pointerId); layer.classList.add('drag'); }
});
mapview.addEventListener('pointermove', e => {
  const prev = ptrs.get(e.pointerId);
  if (!prev) return;
  const dx = e.clientX - prev[0], dy = e.clientY - prev[1];
  moved += Math.abs(dx) + Math.abs(dy);
  if (S.mode === 'full') {
    const r = mapview.getBoundingClientRect();
    if (ptrs.size === 1) { S.full.x += dx; S.full.y += dy; if (moved > 8) S.follow = false; }
    else if (ptrs.size === 2) {
      const other = [...ptrs.entries()].find(([id]) => id !== e.pointerId)[1];
      const d0 = Math.hypot(prev[0] - other[0], prev[1] - other[1]), d1 = Math.hypot(e.clientX - other[0], e.clientY - other[1]);
      if (d0 > 10) zoomAt((e.clientX + other[0]) / 2 - r.left, (e.clientY + other[1]) / 2 - r.top, d1 / d0);
    }
    render();
  }
  ptrs.set(e.pointerId, [e.clientX, e.clientY]);
});
const endPtr = e => {
  if (!ptrs.delete(e.pointerId)) return;
  if (!ptrs.size) layer.classList.remove('drag');
  if (moved < 10 && e.type === 'pointerup') {   // касание точки на карте показывает её в карточке
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('.poi');
    if (el) { S.selected = +el.dataset.id; refreshMarkers(); render(); }
  }
};
mapview.addEventListener('pointerup', endPtr); mapview.addEventListener('pointercancel', endPtr);
mapview.addEventListener('wheel', e => {
  if (S.mode !== 'full') return;
  e.preventDefault();
  const r = mapview.getBoundingClientRect();
  layer.classList.add('drag'); zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.2 : 1 / 1.2); render();
  requestAnimationFrame(() => layer.classList.remove('drag'));
}, { passive: false });

async function keepAwake() { try { S.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* не поддерживается */ } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.phase === 'run') keepAwake(); });
addEventListener('resize', () => { if (S.phase === 'setup') layoutStage(); else if (S.phase === 'run') { if (S.mode === 'full' && !S.follow) fitFull(); render(); } });
video.addEventListener('loadedmetadata', () => { if (S.phase === 'setup') layoutStage(); });
if (video.requestVideoFrameCallback) {   // точное время показанного кадра: нужно для сверки с истиной в демо
  const onFrame = (now, m) => { S.frameTime = m.mediaTime; video.requestVideoFrameCallback(onFrame); };
  video.requestVideoFrameCallback(onFrame);
}

S.debug = { grabMinimap };   // для проверок из консоли
init();
