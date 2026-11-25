// Распознавание позиции по мини-карте. Перенос locate.py и Tracker из track_video.py.
// Детектор AKAZE: в браузерной сборке OpenCV нет SIFT.

function lcg(seed) {
  let s = seed >>> 0;
  return n => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return Math.floor(s / 4294967296 * n); };
}

// Поворот + масштаб + сдвиг по двум парам точек, RANSAC, затем уточнение по всем согласным парам.
function ransacSimilarity(src, dst, n, thr, iters = 900) {
  const thr2 = thr * thr, rnd = lcg(12345);
  let best = 0, bm = null;
  const count = (ar, ai, bx, by, mark) => {
    let c = 0;
    for (let k = 0; k < n; k++) {
      const x = src[2 * k], y = src[2 * k + 1];
      const ex = ar * x - ai * y + bx - dst[2 * k], ey = ai * x + ar * y + by - dst[2 * k + 1];
      const ok = ex * ex + ey * ey < thr2;
      if (ok) c++;
      if (mark) mark[k] = ok ? 1 : 0;
    }
    return c;
  };
  for (let it = 0; it < iters; it++) {
    const i = rnd(n), j = rnd(n);
    if (i === j) continue;
    const dx = src[2 * j] - src[2 * i], dy = src[2 * j + 1] - src[2 * i + 1];
    const den = dx * dx + dy * dy;
    if (den < 16) continue;
    const ex = dst[2 * j] - dst[2 * i], ey = dst[2 * j + 1] - dst[2 * i + 1];
    const ar = (ex * dx + ey * dy) / den, ai = (ey * dx - ex * dy) / den;
    const bx = dst[2 * i] - (ar * src[2 * i] - ai * src[2 * i + 1]);
    const by = dst[2 * i + 1] - (ai * src[2 * i] + ar * src[2 * i + 1]);
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
  const c = count(bm[0], bm[1], bm[2], bm[3], inl);
  return { ar: bm[0], ai: bm[1], bx: bm[2], by: bm[3], inl, count: c };
}

export class Locator {
  constructor(cv, meta, buf) {
    this.cv = cv; this.m = meta;
    const n = meta.n, ds = meta.descSize;
    this.xy = new Float32Array(buf.slice(0, n * 8));
    this.descBytes = new Uint8Array(buf, n * 8, n * ds);
    this.descMat = cv.matFromArray(n, ds, cv.CV_8U, this.descBytes);  // вся карта, для поиска без подсказки
    this.akaze = new cv.AKAZE();
    this.akaze.setThreshold(meta.akazeThreshold);
    this.bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
    this.clahe = meta.clahe && cv.CLAHE ? new cv.CLAHE(meta.clahe[0], new cv.Size(meta.clahe[1], meta.clahe[1])) : null;
    this.mask = null;
    this.timing = {};
  }

  _mask(w, h) {
    const cv = this.cv, m = this.m, up = m.upscale;
    if (this.mask && this.mask.cols === w * up && this.mask.rows === h * up) return this.mask;
    if (this.mask) this.mask.delete();
    const mask = cv.Mat.zeros(h * up, w * up, cv.CV_8U);
    const c = new cv.Point(w * up / 2, h * up / 2);
    if (m.minimap.shape === 'circle') {
      cv.ellipse(mask, c, new cv.Size(w * up / 2 * m.edgeMask, h * up / 2 * m.edgeMask), 0, 0, 360, new cv.Scalar(255), -1);
    } else {
      const mg = Math.min(w, h) * up * (1 - m.edgeMask) / 2;
      cv.rectangle(mask, new cv.Point(mg, mg), new cv.Point(w * up - mg, h * up - mg), new cv.Scalar(255), -1);
    }
    cv.circle(mask, c, Math.min(w, h) * up / 2 * m.playerMask, new cv.Scalar(0), -1);
    return (this.mask = mask);
  }

  // rgba: cv.Mat мини-карты (RGBA). lastPos: [x, y] на карте или null. Возвращает позицию или null.
  locate(rgba, lastPos = null, limit = 900) {
    const cv = this.cv, m = this.m, w = rgba.cols, h = rgba.rows, up = m.upscale;
    if (!lastPos) limit = Math.min(limit, 500);   // поиск по всей карте дорогой: берём меньше точек запроса
    const t0 = performance.now();
    const gray = new cv.Mat(), big = new cv.Mat(), kp = new cv.KeyPointVector(), des = new cv.Mat();
    let sub = null, matches = null;
    try {
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      // растяжка контраста по рабочей части мини-карты: тёмный кадр иначе не даёт точек
      const hist = new Uint32Array(256), d = gray.data, ax = w / 2 * m.edgeMask, ay = h / 2 * m.edgeMask;
      let cnt = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const u = (x - w / 2) / ax, v = (y - h / 2) / ay;
        if (m.minimap.shape !== 'circle' || u * u + v * v < 1) { hist[d[y * w + x]]++; cnt++; }
      }
      let lo = 0, hi = 255, acc = 0;
      for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= cnt * 0.01) { lo = i; break; } }
      acc = 0;
      for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= cnt * 0.01) { hi = i; break; } }
      const a = 255 / Math.max(hi - lo, 8);
      gray.convertTo(gray, cv.CV_8U, a, -lo * a);
      if (this.clahe) this.clahe.apply(gray, gray);   // локальный контраст: бледная карта, яркие значки
      cv.resize(gray, big, new cv.Size(w * up, h * up), 0, 0, cv.INTER_CUBIC);
      this.akaze.detectAndCompute(big, this._mask(w, h), kp, des);
      const nk = kp.size();
      this.timing.detect = performance.now() - t0;
      if (nk < 8 || des.rows < 8) return null;

      // самые выразительные точки запроса
      const pts = new Float32Array(nk * 2), resp = new Float32Array(nk);
      for (let i = 0; i < nk; i++) { const k = kp.get(i); pts[2 * i] = k.pt.x / up; pts[2 * i + 1] = k.pt.y / up; resp[i] = k.response; }
      let order = null, qDes = des;
      if (nk > limit) {
        order = Array.from({ length: nk }, (_, i) => i).sort((p, q) => resp[q] - resp[p]).slice(0, limit);
        const ds = m.descSize, src = des.data;
        qDes = new cv.Mat(limit, ds, cv.CV_8U);
        for (let r = 0; r < limit; r++) qDes.data.set(src.subarray(order[r] * ds, order[r] * ds + ds), r * ds);
      }
      const qn = qDes.rows, qi = r => (order ? order[r] : r);

      // кандидаты на карте: рядом с прошлой позицией или вся карта
      let cand = null, train = this.descMat, ratio = m.ratioGlobal, minInl = m.minInliersGlobal;
      const t1 = performance.now();
      if (lastPos) {
        const r2 = m.searchRadius * m.searchRadius, xy = this.xy, list = [];
        for (let i = 0; i < m.n; i++) { const dx = xy[2 * i] - lastPos[0], dy = xy[2 * i + 1] - lastPos[1]; if (dx * dx + dy * dy < r2) list.push(i); }
        if (list.length < 8) { if (qDes !== des) qDes.delete(); return null; }
        const ds = m.descSize;
        sub = new cv.Mat(list.length, ds, cv.CV_8U);
        for (let r = 0; r < list.length; r++) sub.data.set(this.descBytes.subarray(list[r] * ds, list[r] * ds + ds), r * ds);
        cand = list; train = sub; ratio = m.ratioLocal; minInl = m.minInliersLocal;
      }
      matches = new cv.DMatchVectorVector();
      this.bf.knnMatch(qDes, train, matches, 2);
      if (qDes !== des) qDes.delete();
      const src = [], dst = [], tix = [];
      for (let r = 0; r < qn; r++) {
        const pair = matches.get(r);
        if (pair.size() < 2) continue;
        const a0 = pair.get(0), a1 = pair.get(1);
        if (a0.distance < ratio * a1.distance) {
          const q = qi(a0.queryIdx), t = cand ? cand[a0.trainIdx] : a0.trainIdx;
          src.push(pts[2 * q], pts[2 * q + 1]); dst.push(this.xy[2 * t], this.xy[2 * t + 1]); tix.push(t);
        }
      }
      this.timing.match = performance.now() - t1;
      const ng = tix.length;
      if (ng < minInl) return null;

      const fit = ransacSimilarity(src, dst, ng, m.ransacThresh);
      if (!fit) return null;
      const uniq = new Set();
      let sx = 0, sy = 0, sxx = 0, syy = 0;
      for (let k = 0; k < ng; k++) if (fit.inl[k]) { uniq.add(tix[k]); sx += src[2 * k]; sy += src[2 * k + 1]; sxx += src[2 * k] ** 2; syy += src[2 * k + 1] ** 2; }
      const nInl = uniq.size, c = fit.count;
      const scale = Math.hypot(fit.ar, fit.ai);
      if (nInl < minInl || scale < m.scaleRange[0] || scale > m.scaleRange[1]) return null;
      const stdx = Math.sqrt(Math.max(0, sxx / c - (sx / c) ** 2)), stdy = Math.sqrt(Math.max(0, syy / c - (sy / c) ** 2));
      if (Math.min(stdx, stdy) < 0.08 * Math.min(w, h)) return null;   // все совпадения в одной кучке
      const x = fit.ar * w / 2 - fit.ai * h / 2 + fit.bx, y = fit.ai * w / 2 + fit.ar * h / 2 + fit.by;
      if (x < 0 || y < 0 || x >= m.mapSize[0] || y >= m.mapSize[1]) return null;
      if (lastPos && Math.hypot(x - lastPos[0], y - lastPos[1]) > m.searchRadius) return null;
      const conf = Math.min(1, nInl / 30) * (0.5 + 0.5 * c / ng);
      if (conf < m.minConfidence) return null;
      const angle = (Math.atan2(fit.ai, fit.ar) * 180 / Math.PI + 360) % 360;
      return { x, y, angle, scale, confidence: conf, inliers: nInl, matches: ng };
    } finally {
      gray.delete(); big.delete(); kp.delete(); des.delete();
      if (sub) sub.delete();
      if (matches) matches.delete();
      this.timing.total = performance.now() - t0;
    }
  }
}

// Слежение: рядом с прошлой позицией, при потере — по всей карте, со сглаживанием.
export class Tracker {
  constructor(locator) { this.loc = locator; this.m = locator.m; this.reset(); }
  reset() { this.pos = null; this.vel = [0, 0]; this.misses = 0; this.pending = null; }

  // Возвращает [статус, позиция | null]. Статусы: track, jump, lost.
  update(minimap, dt) {
    const m = this.m;
    if (this.pending) {
      const loc = this.loc.locate(minimap, this.pending);
      this.pending = null;
      if (loc) return this._accept(loc, null, dt, 'jump');
    }
    if (this.pos) {
      const pred = [this.pos[0] + this.vel[0] * dt, this.pos[1] + this.vel[1] * dt];
      const loc = this.loc.locate(minimap, pred);
      if (loc) return this._accept(loc, pred, dt, 'track');
      this.misses++;
      if (this.misses < m.lostAfter) return ['lost', null];
    }
    const loc = this.loc.locate(minimap, null);
    if (!loc) return ['lost', null];
    const far = this.pos && Math.hypot(loc.x - this.pos[0], loc.y - this.pos[1]) > m.maxSpeed * dt * (this.misses + 1);
    if (far && loc.confidence < 0.6) { this.pending = [loc.x, loc.y]; return ['lost', null]; }
    return this._accept(loc, null, dt, this.pos ? 'jump' : 'track');
  }

  _accept(loc, pred, dt, status) {
    if (!pred) { this.pos = [loc.x, loc.y]; this.vel = [0, 0]; }
    else {
      const s = this.m.smooth;
      const nx = s * loc.x + (1 - s) * pred[0], ny = s * loc.y + (1 - s) * pred[1];
      this.vel = [0.5 * this.vel[0] + 0.5 * (nx - this.pos[0]) / dt, 0.5 * this.vel[1] + 0.5 * (ny - this.pos[1]) / dt];
      this.pos = [nx, ny];
    }
    this.misses = 0;
    loc.x = this.pos[0]; loc.y = this.pos[1];
    return [status, loc];
  }
}
