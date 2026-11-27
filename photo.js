// Позиция игрока по одному фото большой карты (2D-вид). Перенос photo_locate.py.
// Особые точки AKAZE с «невращаемыми» описаниями; совпадения ищутся своими хеш-таблицами
// (полный перебор в браузере шёл 20+ секунд), точная привязка — findHomography.

const applyH = (h, x, y) => { const w = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]; };
const mul3 = (a, b) => { const o = new Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]; return o; };
const pct = (arr, q) => { const s = Float32Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

const pop32 = v => { v -= (v >>> 1) & 0x55555555; v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24; };
const WORDS = 16;   // описание 61 байт = 16 слов по 32 бита (с дополнением нулями)

function toWords(bytes, n, ds) {
  const out = new Uint32Array(n * WORDS), pad = new Uint8Array(out.buffer);
  for (let i = 0; i < n; i++) pad.set(bytes.subarray(i * ds, i * ds + ds), i * WORDS * 4);
  return out;
}

function lcg(seed) {
  let s = seed >>> 0;
  return n => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return Math.floor(s / 4294967296 * n); };
}

export class PhotoLocator {
  constructor(cv, meta, buf) {
    this.cv = cv; this.m = meta; this.p = meta.photo;
    const n = meta.n, ds = meta.descSize, p = this.p;
    this.xy = new Float32Array(buf.slice(0, n * 8));
    this.descBytes = new Uint8Array(buf, n * 8, n * ds);
    this.words = toWords(this.descBytes, n, ds);
    this.akaze = new cv.AKAZE();
    this.akaze.setDescriptorType(cv.AKAZE_DescriptorType.DESCRIPTOR_MLDB_UPRIGHT);   // нужен OpenCV.js 4.11+; числом тип не задаётся
    this.akaze.setThreshold(p.threshold);
    this.log = [];
    // хеш-таблицы: ключ = выбранные биты описания; точки карты разложены по корзинам
    this.tables = p.lsh.map(pos => {
      const size = 1 << pos.length, keys = new Uint32Array(n), start = new Uint32Array(size + 1), order = new Uint32Array(n);
      for (let i = 0; i < n; i++) { const k = this._key(this.descBytes, i * ds, pos); keys[i] = k; start[k + 1]++; }
      for (let k = 0; k < size; k++) start[k + 1] += start[k];
      const fill = start.slice(0, size);
      for (let i = 0; i < n; i++) order[fill[keys[i]]++] = i;
      return { pos, start, order };
    });
    // сетка по координатам карты: быстрый поиск точек рядом с предсказанным местом
    const cell = this.cell = Math.max(8, p.guidedRadius), gw = this.gw = Math.ceil(meta.mapSize[0] / cell) + 1, gh = this.gh = Math.ceil(meta.mapSize[1] / cell) + 1;
    const gs = this.gStart = new Uint32Array(gw * gh + 1), go = this.gOrder = new Uint32Array(n), gc = new Uint32Array(n);
    for (let i = 0; i < n; i++) { const c = Math.min(gh - 1, Math.max(0, Math.floor(this.xy[2 * i + 1] / cell))) * gw + Math.min(gw - 1, Math.max(0, Math.floor(this.xy[2 * i] / cell))); gc[i] = c; gs[c + 1]++; }
    for (let c = 0; c < gw * gh; c++) gs[c + 1] += gs[c];
    const gf = gs.slice(0, gw * gh);
    for (let i = 0; i < n; i++) go[gf[gc[i]]++] = i;
    this.seen = new Uint32Array(n); this.stamp = 0;
  }

  _key(bytes, off, pos) {
    let k = 0;
    for (let i = 0; i < pos.length; i++) k |= ((bytes[off + (pos[i] >> 3)] >> (pos[i] & 7)) & 1) << i;
    return k;
  }

  _dist(qw, qo, mo, limit) {   // расстояние Хэмминга с ранним выходом
    const mw = this.words;
    let d = 0;
    for (let w = 0; w < WORDS; w++) { d += pop32(qw[qo + w] ^ mw[mo + w]); if (d > limit) return d; }
    return d;
  }

  // Лучшая пара на карте для каждой точки фото среди кандидатов из хеш-таблиц.
  _lshMatch(desBytes, qw, nk, pts) {
    const p = this.p, ds = this.m.descSize, src = [], dst = [], seen = this.seen;
    let cand = 0;
    for (let q = 0; q < nk; q++) {
      const stamp = ++this.stamp, qo = q * WORDS;
      let d1 = 999, d2 = 999, best = -1;
      for (const t of this.tables) {
        const key = this._key(desBytes, q * ds, t.pos), nb = t.pos.length;
        for (let f = -1; f < nb; f++) {
          const k = f < 0 ? key : key ^ (1 << f);
          for (let e = t.start[k], end = t.start[k + 1]; e < end; e++) {
            const j = t.order[e];
            if (seen[j] === stamp) continue;
            seen[j] = stamp; cand++;
            const d = this._dist(qw, qo, j * WORDS, d2);
            if (d < d1) { d2 = d1; d1 = d; best = j; } else if (d < d2) d2 = d;
          }
        }
      }
      if (best >= 0 && d1 <= p.absMax && d1 < p.ratio * d2) { src.push(pts[2 * q], pts[2 * q + 1]); dst.push(this.xy[2 * best], this.xy[2 * best + 1]); }
    }
    return [src, dst, cand];
  }

  // Поворот + масштаб + сдвиг по двум парам; масштаб вне допустимого отбрасывается сразу.
  _similarity(src, dst) {
    const p = this.p, n = src.length / 2, thr2 = p.simThr * p.simThr, rnd = lcg(12345), [lo, hi] = p.scaleRange;
    if (n < 4) return null;
    const count = (ar, ai, bx, by, mark) => {
      let c = 0;
      for (let k = 0; k < n; k++) {
        const x = src[2 * k], y = src[2 * k + 1], ex = ar * x - ai * y + bx - dst[2 * k], ey = ai * x + ar * y + by - dst[2 * k + 1];
        const ok = ex * ex + ey * ey < thr2;
        if (ok) c++;
        if (mark) mark[k] = ok ? 1 : 0;
      }
      return c;
    };
    let best = 0, bm = null;
    for (let it = 0; it < p.simIters; it++) {
      const i = rnd(n), j = rnd(n);
      const dx = src[2 * j] - src[2 * i], dy = src[2 * j + 1] - src[2 * i + 1], den = dx * dx + dy * dy;
      if (den < 16) continue;
      const ex = dst[2 * j] - dst[2 * i], ey = dst[2 * j + 1] - dst[2 * i + 1];
      const ar = (ex * dx + ey * dy) / den, ai = (ey * dx - ex * dy) / den, sc = Math.hypot(ar, ai);
      if (!(sc > lo && sc < hi)) continue;
      const bx = dst[2 * i] - (ar * src[2 * i] - ai * src[2 * i + 1]), by = dst[2 * i + 1] - (ai * src[2 * i] + ar * src[2 * i + 1]);
      const c = count(ar, ai, bx, by, null);
      if (c > best) { best = c; bm = [ar, ai, bx, by]; }
    }
    if (!bm) return null;
    const inl = new Uint8Array(n);
    for (let round = 0; round < 2; round++) {
      const c = count(bm[0], bm[1], bm[2], bm[3], inl);
      if (c < 2) return null;
      let sx = 0, sy = 0, tx = 0, ty = 0;
      for (let k = 0; k < n; k++) if (inl[k]) { sx += src[2 * k]; sy += src[2 * k + 1]; tx += dst[2 * k]; ty += dst[2 * k + 1]; }
      sx /= c; sy /= c; tx /= c; ty /= c;
      let nr = 0, ni = 0, den = 0;
      for (let k = 0; k < n; k++) if (inl[k]) {
        const px = src[2 * k] - sx, py = src[2 * k + 1] - sy, qx = dst[2 * k] - tx, qy = dst[2 * k + 1] - ty;
        nr += px * qx + py * qy; ni += px * qy - py * qx; den += px * px + py * py;
      }
      if (den < 1e-6) return null;
      const ar = nr / den, ai = ni / den;
      bm = [ar, ai, tx - (ar * sx - ai * sy), ty - (ai * sx + ar * sy)];
    }
    return { m: bm, count: count(bm[0], bm[1], bm[2], bm[3], inl) };
  }

  // Когда место примерно известно: пара для точки фото ищется только рядом с предсказанием.
  _guided(m, qw, nk, pts) {
    const p = this.p, r = p.guidedRadius, r2 = r * r, cell = this.cell, gw = this.gw, gh = this.gh, src = [], dst = [];
    for (let q = 0; q < nk; q++) {
      const x = pts[2 * q], y = pts[2 * q + 1], px = m[0] * x - m[1] * y + m[2], py = m[1] * x + m[0] * y + m[3];
      const cx0 = Math.floor((px - r) / cell), cx1 = Math.floor((px + r) / cell), cy0 = Math.floor((py - r) / cell), cy1 = Math.floor((py + r) / cell);
      if (cx1 < 0 || cy1 < 0 || cx0 >= gw || cy0 >= gh) continue;
      let d1 = 999, d2 = 999, best = -1;
      for (let cy = Math.max(0, cy0); cy <= Math.min(gh - 1, cy1); cy++) for (let cx = Math.max(0, cx0); cx <= Math.min(gw - 1, cx1); cx++) {
        const c = cy * gw + cx;
        for (let e = this.gStart[c], end = this.gStart[c + 1]; e < end; e++) {
          const j = this.gOrder[e], dx = this.xy[2 * j] - px, dy = this.xy[2 * j + 1] - py;
          if (dx * dx + dy * dy > r2) continue;
          const d = this._dist(qw, q * WORDS, j * WORDS, d2);
          if (d < d1) { d2 = d1; d1 = d; best = j; } else if (d < d2) d2 = d;
        }
      }
      if (best >= 0 && d1 <= p.absMax && d1 < p.ratioLocal * d2) { src.push(x, y); dst.push(this.xy[2 * best], this.xy[2 * best + 1]); }
    }
    return [src, dst];
  }

  _homography(src, dst, thr) {
    const cv = this.cv, n = src.length / 2;
    if (n < 8) return null;
    const a = cv.matFromArray(n, 1, cv.CV_32FC2, src), b = cv.matFromArray(n, 1, cv.CV_32FC2, dst), mask = new cv.Mat();
    let H = null;
    try {
      H = cv.findHomography(a, b, cv.RANSAC, thr, mask, 5000, 0.999);
      if (!H || H.rows !== 3) return null;
      const inl = Array.from(mask.data);
      return { h: Array.from(H.data64F), inl, count: inl.reduce((s, v) => s + (v ? 1 : 0), 0) };
    } finally { a.delete(); b.delete(); mask.delete(); if (H) H.delete(); }
  }

  _sane(h, w, hh) {   // привязка похожа на «поворот + масштаб», без зеркала и сильного перекоса
    const p = this.p, c = applyH(h, w / 2, hh / 2), px = applyH(h, w / 2 + 1, hh / 2), py = applyH(h, w / 2, hh / 2 + 1);
    const a = px[0] - c[0], b = py[0] - c[0], cc = px[1] - c[1], d = py[1] - c[1], det = a * d - b * cc;
    if (!(det > 0)) return false;
    const q = a * a + b * b + cc * cc + d * d, s1 = Math.sqrt((q + Math.sqrt(Math.max(0, q * q - 4 * det * det))) / 2), s2 = det / s1;
    const scale = Math.sqrt(det);
    return scale > p.scaleRange[0] && scale < p.scaleRange[1] && s1 / s2 < p.maxAspect;
  }

  // gray: cv.Mat приведённого фото. Возвращает {h: фото -> карта, inliers, pts: согласные точки на фото} или null.
  register(gray) {
    const cv = this.cv, p = this.p, w = gray.cols, hh = gray.rows, ds = this.m.descSize;
    for (const roll of p.rolls) {
      const t0 = performance.now(), step = { roll };
      this.log.push(step);
      const kp = new cv.KeyPointVector(), des = new cv.Mat(), none = new cv.Mat();
      let g = gray;
      let R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      try {
        if (roll) {
          const rm = cv.getRotationMatrix2D(new cv.Point(w / 2, hh / 2), roll, 1);
          R = [...rm.data64F, 0, 0, 1];
          g = new cv.Mat();
          cv.warpAffine(gray, g, rm, new cv.Size(w, hh));
          rm.delete();
        }
        this.akaze.detectAndCompute(g, none, kp, des);
        let nk = kp.size();
        step.kp = nk; step.detect = Math.round(performance.now() - t0);
        if (nk < 50 || des.rows < 50) continue;
        let pts = new Float32Array(nk * 2), bytes = des.data.slice();   // копия: память wasm может переехать
        const resp = new Float32Array(nk);
        for (let i = 0; i < nk; i++) { const k = kp.get(i); pts[2 * i] = k.pt.x; pts[2 * i + 1] = k.pt.y; resp[i] = k.response; }
        if (nk > p.limit) {
          const order = Array.from({ length: nk }, (_, i) => i).sort((a, b) => resp[b] - resp[a]).slice(0, p.limit);
          const nb = new Uint8Array(p.limit * ds), np = new Float32Array(p.limit * 2);
          order.forEach((o, r) => { nb.set(bytes.subarray(o * ds, o * ds + ds), r * ds); np[2 * r] = pts[2 * o]; np[2 * r + 1] = pts[2 * o + 1]; });
          pts = np; bytes = nb; nk = p.limit;
        }
        const qw = toWords(bytes, nk, ds);
        const t1 = performance.now();
        let [src, dst, cand] = this._lshMatch(bytes, qw, nk, pts);
        step.match = Math.round(performance.now() - t1); step.cand = cand; step.good = src.length / 2;
        const sim = this._similarity(src, dst);
        step.coarse = sim ? sim.count : 0;
        if (!sim || sim.count < p.minCoarse) continue;
        [src, dst] = this._guided(sim.m, qw, nk, pts);
        const fit = this._homography(src, dst, p.ransacLocal);
        step.guided = src.length / 2; step.inliers = fit ? fit.count : 0;
        if (!fit || fit.count < p.minInliers) continue;
        const h = mul3(fit.h, R);
        if (!this._sane(h, w, hh)) { step.reject = 'shape'; continue; }
        // согласные точки в координатах исходного (не довёрнутого) фото
        const det = R[0] * R[4] - R[1] * R[3], back = [];
        for (let k = 0; k < fit.inl.length; k++) if (fit.inl[k]) {
          const x = src[2 * k] - R[2], y = src[2 * k + 1] - R[5];
          back.push([(R[4] * x - R[1] * y) / det, (-R[3] * x + R[0] * y) / det]);
        }
        const xs = back.map(q => q[0]), ys = back.map(q => q[1]);
        if (Math.min(pct(xs, 0.95) - pct(xs, 0.05), pct(ys, 0.95) - pct(ys, 0.05)) < p.minSpread * Math.max(w, hh)) { step.reject = 'spread'; continue; }
        return { h, inliers: fit.count, pts: back };
      } finally {
        kp.delete(); des.delete(); none.delete();
        if (g !== gray) g.delete();
        step.ms = Math.round(performance.now() - t0);
      }
    }
    return null;
  }

  _annulus(r0, r1) {
    const cv = this.cv, size = (2 * Math.ceil(r1) + 3) | 1, c = size >> 1, data = new Float32Array(size * size);
    let sum = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      if (d >= r0 && d <= r1) { data[y * size + x] = 1; sum++; }
    }
    for (let i = 0; i < data.length; i++) data[i] /= sum;
    return cv.matFromArray(size, size, cv.CV_32F, data);
  }

  // Значок игрока: светлый центр, тёмный диск, светлое кольцо. rgba — приведённое фото, box — где искать.
  findMarker(rgba, box) {
    const cv = this.cv, rp = this.p.ring, [x0, y0, x1, y1] = box, bw = x1 - x0, bh = y1 - y0;
    if (bw < 40 || bh < 40) return null;
    const roi = rgba.roi(new cv.Rect(x0, y0, bw, bh)), ch = new cv.MatVector(), v8 = new cv.Mat(), v = new cv.Mat();
    const c = new cv.Mat(), d = new cv.Mat(), r = new cv.Mat(), s = new cv.Mat(), anchor = new cv.Point(-1, -1);
    let best = null;
    try {
      cv.split(roi, ch);
      const cr = ch.get(0), cg = ch.get(1), cb = ch.get(2);
      cv.max(cr, cg, v8); cv.max(v8, cb, v8);
      cr.delete(); cg.delete(); cb.delete();
      v8.convertTo(v, cv.CV_32F);
      for (const k of rp.scales) {
        const m = Math.floor(rp.ring[1] * k);
        if (2 * rp.ring[1] * k + 4 > Math.min(bw, bh)) continue;
        const kc = this._annulus(0, rp.centre * k), kd = this._annulus(rp.disc[0] * k, rp.disc[1] * k), kr = this._annulus(rp.ring[0] * k, rp.ring[1] * k);
        cv.filter2D(v, c, cv.CV_32F, kc, anchor, 0, cv.BORDER_REFLECT_101);
        cv.filter2D(v, d, cv.CV_32F, kd, anchor, 0, cv.BORDER_REFLECT_101);
        cv.filter2D(v, r, cv.CV_32F, kr, anchor, 0, cv.BORDER_REFLECT_101);
        kc.delete(); kd.delete(); kr.delete();
        cv.subtract(c, d, c); cv.subtract(r, d, r); cv.min(c, r, s);
        const inner = s.roi(new cv.Rect(m, m, bw - 2 * m, bh - 2 * m));
        const top = cv.minMaxLoc(inner);
        cv.circle(inner, top.maxLoc, Math.floor(60 * k), new cv.Scalar(-1000), -1);
        const second = cv.minMaxLoc(inner).maxVal;
        inner.delete();
        if (!best || top.maxVal > best.score) best = { score: top.maxVal, x: x0 + m + top.maxLoc.x, y: y0 + m + top.maxLoc.y, k, second };
      }
    } finally { roi.delete(); ch.delete(); v8.delete(); v.delete(); c.delete(); d.delete(); r.delete(); s.delete(); }
    this.log.push({ marker: best });
    if (!best || best.score < rp.minScore || best.score < rp.margin * best.second) return null;
    return best;
  }

  // canvas с фото (любого размера). Возвращает {x, y — px карты; inliers; marker; h: px canvas -> px карты; photo: [x, y] значка на canvas} или null.
  locate(canvas) {
    const cv = this.cv, p = this.p, t0 = performance.now();
    this.log = [];
    const full = cv.imread(canvas), small = new cv.Mat(), gray = new cv.Mat();
    try {
      const f = p.side / Math.max(full.cols, full.rows);
      cv.resize(full, small, new cv.Size(Math.round(full.cols * f), Math.round(full.rows * f)), 0, 0, f < 1 ? cv.INTER_AREA : cv.INTER_CUBIC);
      cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
      const reg = this.register(gray);
      if (!reg) return null;
      const w = small.cols, hh = small.rows;
      const xs = reg.pts.map(q => q[0]), ys = reg.pts.map(q => q[1]);
      const lx = Math.min(...xs), hx = Math.max(...xs), ly = Math.min(...ys), hy = Math.max(...ys);
      const px = 0.3 * (hx - lx), py = 0.3 * (hy - ly);   // игрок часто стоит на краю открытой части карты
      const box = [Math.max(0, Math.floor(lx - px)), Math.max(0, Math.floor(ly - py)), Math.min(w, Math.ceil(hx + px)), Math.min(hh, Math.ceil(hy + py))];
      const tm = performance.now();
      const mk = this.findMarker(small, box);
      this.log.push({ markerMs: Math.round(performance.now() - tm) });
      const at = mk ? [mk.x, mk.y] : [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
      const [x, y] = applyH(reg.h, at[0], at[1]);
      return { x, y, inliers: reg.inliers, marker: !!mk, h: mul3(reg.h, [f, 0, 0, 0, f, 0, 0, 0, 1]), photo: [at[0] / f, at[1] / f], ms: Math.round(performance.now() - t0) };
    } finally { full.delete(); small.delete(); gray.delete(); }
  }
}

export { applyH };
