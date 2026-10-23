// The home page's background, after the 5D Chess title screen as 5dcol draws it
// (packages/frontend/src/components/MainMenuAnimation.vue, MIT, Copyright (c) 2026 5dcol
// contributors): a checkered vortex turning slowly in the middle of the screen, and pieces flying
// out of it toward the viewer, small and still at first, then rushing past while they spin and
// fade. Everything is one 2D canvas. Click a piece, then the same kind of the other colour, and
// both annihilate.

const VORTEX = {
  centerXRatio: 0.5,
  centerYRatio: 0.51,
  renderScale: 0.5,
  innerRadius: 4,
  outerRadiusScale: 1.65,
  ringCount: 42,
  sectorCount: 8,
  twistPerRing: 0.24,
  direction: 1,
  durationSeconds: 3,
  glowRadiusScale: 0.36,
  glowOpacity: 1,
  layerOpacity: 0.86,
  radiusGrowth: 7.5,
  tileInnerOpacity: 0.24,
  tileOuterOpacity: 0.82,
  tileCoreSkipRadiusScale: 0.055,
  tileCoreFadeRadiusScale: 0.065,
  vignetteRadiusScale: 0.9,
  vignetteOpacity: 0.46,
};

const PIECES = {
  maxPieces: 24,
  colorBalanceStrength: 0.12,
  colorBalanceMaxBias: 0.38,
  spawnDelayMinMs: 500,
  spawnDelayMaxMs: 1000,
  durationMinMs: 7500,
  durationMaxMs: 7500,
  centerRadiusMin: 3,
  centerRadiusScale: 0.022,
  screenPlaneDistanceRatioMin: 1.2,
  screenPlaneDistanceRatioMax: 2.0,
  baseSizeScale: 0.05,
  baseSizeMin: 36,
  baseSizeMax: 80,
  startScaleMin: 0.2,
  startScaleMax: 0.28,
  endScaleMin: 20,
  endScaleMax: 30,
  bezier: [0.95, 0, 1, 0],
  screenPlaneFadeStart: 0.62,
  spinMinTurns: 0.5,
  spinMaxTurns: 1.0,
};

const ANNIHILATION_FADE_MS = 260;
const HIT_MASK_SIZE = 128;
const HIT_ALPHA_THRESHOLD = 24;
const BACKGROUND = '#7889aa';

const KINDS = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];
const ASSETS = ['white', 'black'].flatMap((color) => KINDS.map((kind) => ({ kind, color, url: `pieces/${kind}-${color}.svg` })));

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const smoothStep = (t) => t * t * (3 - 2 * t);
const polar = (cx, cy, r, a) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];

function bezierAxis(t, p1, p2) {
  const inv = 1 - t;
  return 3 * inv * inv * t * p1 + 3 * inv * t * t * p2 + t * t * t;
}

function bezierEase(t, [x1, y1, x2, y2]) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  let lo = 0, hi = 1, u = t;
  for (let i = 0; i < 12; i++) {
    u = (lo + hi) / 2;
    if (bezierAxis(u, x1, x2) < t) lo = u;
    else hi = u;
  }
  return bezierAxis(u, y1, y2);
}

function edgeDistance(x, y, angle, w, h) {
  const dx = Math.cos(angle), dy = Math.sin(angle);
  const tx = dx > 0 ? (w - x) / dx : dx < 0 ? -x / dx : Infinity;
  const ty = dy > 0 ? (h - y) / dy : dy < 0 ? -y / dy : Infinity;
  return Math.max(0, Math.min(tx, ty));
}

function vortexRadiusAt(inner, outer, rings, growth, coord) {
  const d = Math.expm1(growth);
  const t = coord / rings;
  return Math.max(0.1, inner + (outer - inner) * (d === 0 ? t : Math.expm1(growth * t) / d));
}

function vortexRadiusProgress(inner, outer, r) {
  if (outer <= inner || r <= inner) return 0;
  if (r >= outer) return 1;
  return Math.log(r / inner) / Math.log(outer / inner);
}

function logSpiralDerivative(r, a, dLog, dA) {
  const rd = r * dLog;
  return [rd * Math.cos(a) - r * dA * Math.sin(a), rd * Math.sin(a) + r * dA * Math.cos(a)];
}

/** A curved tile edge (a log spiral from one radius and angle to another) as a cubic. */
function logSpiralTo(ctx, cx, cy, r0, a0, r1, a1) {
  const from = polar(cx, cy, r0, a0), to = polar(cx, cy, r1, a1);
  const dLog = Math.log(r1 / r0), dA = a1 - a0;
  const d0 = logSpiralDerivative(r0, a0, dLog, dA), d1 = logSpiralDerivative(r1, a1, dLog, dA);
  ctx.bezierCurveTo(from[0] + d0[0] / 3, from[1] + d0[1] / 3, to[0] - d1[0] / 3, to[1] - d1[1] / 3, to[0], to[1]);
}

export class TitleScreen {
  /** `canvas` fills its parent; `onScore(n)` hears the annihilation count. */
  constructor(canvas, { onScore = null } = {}) {
    this.canvas = canvas;
    this.onScore = onScore;
    this.pieces = [];
    this.nextId = 0;
    this.selected = null;
    this.score = 0;
    this.cycle = 0;
    this.frameTime = performance.now();
    this.raf = null;
    this.spawnTimer = null;
    this.running = false;
    this.w = 0;
    this.h = 0;
    this.images = new Map();
    this.masks = new Map();
    this.buffer = document.createElement('canvas');
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
    canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.pointerMove(e));
    canvas.addEventListener('pointerleave', () => { canvas.style.cursor = ''; });
    new ResizeObserver(() => this.resize()).observe(canvas);
    // A hidden tab neither draws nor spawns (5dcol keeps spawning; nobody sees those pieces).
    document.addEventListener('visibilitychange', () => {
      if (!this.running) return;
      if (document.hidden) this.pause();
      else this.resume();
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.resize();
    this.resume();
  }

  stop() {
    this.running = false;
    this.pause();
    this.pieces = [];
    this.selected = null;
    this.setScore(0);
  }

  pause() {
    if (this.raf != null) cancelAnimationFrame(this.raf);
    this.raf = null;
    clearTimeout(this.spawnTimer);
    this.spawnTimer = null;
  }

  resume() {
    if (this.reduced.matches) {
      this.draw(performance.now());
      return;
    }
    if (this.raf == null) {
      const period = VORTEX.durationSeconds * 1000;
      const startedAt = performance.now() - this.cycle * period;
      const frame = (t) => {
        this.cycle = (t - startedAt) / period;
        this.draw(t);
        this.raf = requestAnimationFrame(frame);
      };
      this.raf = requestAnimationFrame(frame);
    }
    if (this.spawnTimer == null) this.scheduleSpawn(160);
  }

  scheduleSpawn(delay = rand(PIECES.spawnDelayMinMs, PIECES.spawnDelayMaxMs)) {
    this.spawnTimer = setTimeout(() => {
      this.spawnTimer = null;
      if (!this.running || document.hidden) return;
      this.spawn();
      this.scheduleSpawn();
    }, delay);
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = r.width, h = r.height;
    if (w === this.w && h === this.h) return;
    // Pieces in flight keep their place relative to the vortex.
    if (this.w > 0 && this.h > 0 && w > 0 && h > 0) {
      const [ocx, ocy] = this.center(this.w, this.h), [ncx, ncy] = this.center(w, h);
      const sx = w / this.w, sy = h / this.h;
      const sb = this.baseSize(w, h) / this.baseSize(this.w, this.h);
      for (const p of this.pieces) {
        p.baseSize *= sb;
        [p.startX, p.startY] = [ncx + (p.startX - ocx) * sx, ncy + (p.startY - ocy) * sy];
        [p.endX, p.endY] = [ncx + (p.endX - ocx) * sx, ncy + (p.endY - ocy) * sy];
      }
    }
    this.w = w;
    this.h = h;
    if (this.running) this.draw(this.frameTime);
  }

  center(w, h) { return [w * VORTEX.centerXRatio, h * VORTEX.centerYRatio]; }

  baseSize(w, h) { return Math.min(PIECES.baseSizeMax, Math.max(PIECES.baseSizeMin, Math.min(w, h) * PIECES.baseSizeScale)); }

  spawn() {
    const { w, h } = this;
    if (w <= 0 || h <= 0) return;
    const now = performance.now();
    this.frameTime = now;
    const [cx, cy] = this.center(w, h);
    const a0 = rand(0, Math.PI * 2);
    const r0 = Math.sqrt(Math.random()) * Math.max(PIECES.centerRadiusMin, Math.min(w, h) * PIECES.centerRadiusScale);
    const startX = cx + Math.cos(a0) * r0, startY = cy + Math.sin(a0) * r0;
    const fly = rand(0, Math.PI * 2);
    const end = edgeDistance(startX, startY, fly, w, h) * rand(PIECES.screenPlaneDistanceRatioMin, PIECES.screenPlaneDistanceRatioMax);
    const startRotate = rand(0, 360);
    const spin = (Math.random() < 0.5 ? -1 : 1) * 360 * rand(PIECES.spinMinTurns, PIECES.spinMaxTurns);
    const asset = this.balancedAsset();
    const piece = {
      id: ++this.nextId, kind: asset.kind, color: asset.color, url: asset.url,
      startedAt: now, durationMs: rand(PIECES.durationMinMs, PIECES.durationMaxMs), baseSize: this.baseSize(w, h),
      startX, startY, endX: startX + Math.cos(fly) * end, endY: startY + Math.sin(fly) * end,
      startScale: rand(PIECES.startScaleMin, PIECES.startScaleMax), endScale: rand(PIECES.endScaleMin, PIECES.endScaleMax),
      startRotate, endRotate: startRotate + spin, annihilatedAt: null,
    };
    this.pieces = [...this.pieces.slice(-PIECES.maxPieces + 1), piece];
    setTimeout(() => this.remove(piece.id), piece.durationMs + 100);
  }

  /** A piece whose colour leans toward the one there are fewer of in flight. */
  balancedAsset() {
    const live = this.pieces.filter((p) => p.annihilatedAt == null);
    const white = live.filter((p) => p.color === 'white').length;
    const pWhite = clamp(0.5 + (live.length - 2 * white) * PIECES.colorBalanceStrength, 0.5 - PIECES.colorBalanceMaxBias, 0.5 + PIECES.colorBalanceMaxBias);
    const color = Math.random() < pWhite ? 'white' : 'black';
    const of = ASSETS.filter((a) => a.color === color);
    return of[Math.floor(Math.random() * of.length)];
  }

  remove(id) {
    this.pieces = this.pieces.filter((p) => p.id !== id);
    if (this.selected === id) this.selected = null;
  }

  image(url) {
    let img = this.images.get(url);
    if (!img) {
      img = new Image();
      img.decoding = 'async';
      img.onload = () => { if (this.running) this.draw(this.frameTime); };
      img.src = url;
      this.images.set(url, img);
    }
    return img;
  }

  // ---------------------------------------------------------------- drawing
  draw(time) {
    const { w, h, canvas } = this;
    if (w <= 0 || h <= 0) return;
    const dpr = devicePixelRatio || 1;
    const dw = Math.floor(w * dpr), dh = Math.floor(h * dpr);
    if (canvas.width !== dw || canvas.height !== dh) {
      canvas.width = dw;
      canvas.height = dh;
    }
    const ctx = canvas.getContext('2d');
    this.frameTime = time;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, w, h);
    this.drawVortexLayer(ctx, this.geometry(w, h), dpr);
    this.drawPieces(ctx);
  }

  geometry(w, h) {
    const c = VORTEX;
    const offset = Math.floor(this.cycle), phase = this.cycle - offset;
    const [cx, cy] = this.center(w, h);
    const maxDist = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
    const inner0 = Math.max(6, c.innerRadius), outer0 = maxDist * c.outerRadiusScale;
    const step = (Math.PI * 2) / c.sectorCount, twist = c.twistPerRing * c.direction;
    const skip = Math.min(w, h) * c.tileCoreSkipRadiusScale;
    const fade = Math.max(1, Math.min(w, h) * c.tileCoreFadeRadiusScale);
    const tiles = [];
    for (let ring = -3; ring < c.ringCount + 3; ring++) {
      const ic = ring + phase, oc = ring + 1 + phase;
      const inner = vortexRadiusAt(inner0, outer0, c.ringCount, c.radiusGrowth, ic);
      const outer = vortexRadiusAt(inner0, outer0, c.ringCount, c.radiusGrowth, oc);
      if (outer <= skip) continue;
      const clipped = Math.max(inner, skip);
      const innerTwist = lerp(ic * twist, oc * twist, vortexRadiusProgress(inner, outer, clipped));
      const outerTwist = oc * twist;
      const opacity = lerp(c.tileInnerOpacity, c.tileOuterOpacity, Math.sqrt(clamp((ic + oc) / 2 / c.ringCount, 0, 1)))
        * smoothStep(clamp((outer - skip) / fade, 0, 1));
      if (opacity <= 0.001) continue;
      for (let s = 0; s < c.sectorCount; s++) {
        tiles.push({
          ring, inner: clipped, outer, opacity,
          innerStart: s * step + innerTwist, innerEnd: (s + 1) * step + innerTwist,
          outerStart: s * step + outerTwist, outerEnd: (s + 1) * step + outerTwist,
          light: (ring + s + offset) % 2 === 0,
        });
      }
    }
    return { cx, cy, glow: Math.max(w, h) * c.glowRadiusScale, vignette: Math.max(w, h) * c.vignetteRadiusScale, tiles };
  }

  /** The vortex at half resolution, scaled up: its only softness. */
  drawVortexLayer(ctx, g, dpr) {
    const { w, h, buffer } = this;
    const bw = Math.max(1, Math.floor(w * dpr * VORTEX.renderScale)), bh = Math.max(1, Math.floor(h * dpr * VORTEX.renderScale));
    if (buffer.width !== bw || buffer.height !== bh) {
      buffer.width = bw;
      buffer.height = bh;
    }
    const b = buffer.getContext('2d');
    const s = dpr * VORTEX.renderScale;
    b.setTransform(s, 0, 0, s, 0, 0);
    b.clearRect(0, 0, w, h);
    this.drawVortex(b, g);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(buffer, 0, 0, w, h);
    ctx.restore();
  }

  drawVortex(ctx, g) {
    const { w, h } = this;
    const c = VORTEX;
    ctx.save();
    ctx.globalAlpha = c.layerOpacity * c.glowOpacity;
    const glow = ctx.createRadialGradient(g.cx, g.cy, 0, g.cx, g.cy, g.glow);
    glow.addColorStop(0, 'rgba(238, 242, 249, 0.96)');
    glow.addColorStop(0.18, 'rgba(219, 228, 241, 0.62)');
    glow.addColorStop(0.62, 'rgba(181, 195, 218, 0.16)');
    glow.addColorStop(1, 'rgba(112, 130, 163, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    // One fill per ring and tone.
    ctx.save();
    let ring = null, batches = [];
    for (const t of g.tiles) {
      if (t.ring !== ring) {
        ring = t.ring;
        batches.push({ light: true, opacity: t.opacity, tiles: [] }, { light: false, opacity: t.opacity, tiles: [] });
      }
      batches[batches.length - (t.light ? 2 : 1)].tiles.push(t);
    }
    for (const batch of batches) {
      if (!batch.tiles.length) continue;
      ctx.globalAlpha = c.layerOpacity * batch.opacity;
      ctx.fillStyle = batch.light ? 'rgba(190, 202, 222, 0.24)' : 'rgba(82, 101, 136, 0.18)';
      ctx.beginPath();
      for (const t of batch.tiles) {
        const p = polar(g.cx, g.cy, t.inner, t.innerStart);
        ctx.moveTo(p[0], p[1]);
        logSpiralTo(ctx, g.cx, g.cy, t.inner, t.innerStart, t.outer, t.outerStart);
        ctx.arc(g.cx, g.cy, t.outer, t.outerStart, t.outerEnd, false);
        logSpiralTo(ctx, g.cx, g.cy, t.outer, t.outerEnd, t.inner, t.innerEnd);
        ctx.arc(g.cx, g.cy, t.inner, t.innerEnd, t.innerStart, true);
        ctx.closePath();
      }
      ctx.fill();
    }
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = c.layerOpacity;
    const vig = ctx.createRadialGradient(g.cx, g.cy, 0, g.cx, g.cy, g.vignette);
    vig.addColorStop(0, 'rgba(118, 136, 169, 0)');
    vig.addColorStop(0.56, 'rgba(118, 136, 169, 0)');
    vig.addColorStop(1, `rgba(55, 68, 96, ${c.vignetteOpacity})`);
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  frame(p) {
    const progress = clamp((this.frameTime - p.startedAt) / p.durationMs, 0, 1);
    const eased = bezierEase(progress, PIECES.bezier);
    const scale = lerp(p.startScale, p.endScale, eased);
    const fadeIn = progress < 0.12 ? progress / 0.12 : 1;
    const fadeOut = 1 - smoothStep(clamp((eased - PIECES.screenPlaneFadeStart) / (1 - PIECES.screenPlaneFadeStart), 0, 1));
    const gone = p.annihilatedAt == null ? 1 : Math.max(0, 1 - (this.frameTime - p.annihilatedAt) / ANNIHILATION_FADE_MS);
    return {
      x: lerp(p.startX, p.endX, eased), y: lerp(p.startY, p.endY, eased), scale,
      rotate: lerp(p.startRotate, p.endRotate, progress), opacity: 0.9 * fadeIn * fadeOut * gone, size: p.baseSize * scale,
    };
  }

  /** Smaller (farther) pieces first, so nearer ones pass over them. */
  drawPieces(ctx) {
    const list = this.pieces.map((p) => ({ p, f: this.frame(p) })).sort((a, b) => a.f.size - b.f.size);
    for (const { p, f } of list) {
      if (f.opacity <= 0) continue;
      const img = this.image(p.url);
      if (!img.complete || !img.naturalWidth) continue;
      ctx.save();
      ctx.globalAlpha = f.opacity;
      ctx.translate(f.x, f.y);
      ctx.rotate((f.rotate * Math.PI) / 180);
      ctx.scale(f.scale, f.scale);
      ctx.drawImage(img, -p.baseSize / 2, -p.baseSize / 2, p.baseSize, p.baseSize);
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------- annihilation
  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  pointerDown(e) {
    const [x, y] = this.local(e);
    const piece = this.pick(x, y);
    if (piece) {
      e.preventDefault();
      const sel = this.selected == null ? null : this.pieces.find((p) => p.id === this.selected);
      if (sel && sel.id !== piece.id && sel.annihilatedAt == null && sel.kind === piece.kind && sel.color !== piece.color) {
        const now = performance.now();
        sel.annihilatedAt = now;
        piece.annihilatedAt = now;
        this.setScore(this.score + 1);
        this.selected = null;
        setTimeout(() => { this.remove(sel.id); this.remove(piece.id); }, ANNIHILATION_FADE_MS + 40);
      } else this.selected = piece.id;
    }
    this.canvas.style.cursor = this.pick(x, y) ? 'pointer' : '';
  }

  pointerMove(e) {
    const [x, y] = this.local(e);
    this.canvas.style.cursor = this.pick(x, y) ? 'pointer' : '';
  }

  setScore(n) {
    this.score = n;
    if (this.onScore) this.onScore(n);
  }

  /** The nearest visible piece under (x, y), by its opaque pixels. */
  pick(x, y) {
    const list = this.pieces.filter((p) => p.annihilatedAt == null).map((p) => ({ p, f: this.frame(p) }))
      .filter(({ f }) => f.opacity > 0.18).sort((a, b) => b.f.size - a.f.size);
    for (const { p, f } of list) {
      const dx = x - f.x, dy = y - f.y, a = (f.rotate * Math.PI) / 180;
      const lx = (dx * Math.cos(a) + dy * Math.sin(a)) / f.scale, ly = (-dx * Math.sin(a) + dy * Math.cos(a)) / f.scale;
      const half = p.baseSize / 2;
      if (Math.abs(lx) > half || Math.abs(ly) > half) continue;
      if (this.opaqueAt(p.url, (lx + half) / p.baseSize, (ly + half) / p.baseSize)) return p;
    }
    return null;
  }

  opaqueAt(url, u, v) {
    let mask = this.masks.get(url);
    if (mask === undefined) {
      const img = this.image(url);
      if (!img.complete || !img.naturalWidth) return false;
      const c = document.createElement('canvas');
      c.width = c.height = HIT_MASK_SIZE;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      try {
        ctx.drawImage(img, 0, 0, HIT_MASK_SIZE, HIT_MASK_SIZE);
        mask = ctx.getImageData(0, 0, HIT_MASK_SIZE, HIT_MASK_SIZE).data;
      } catch (err) { mask = null; }
      this.masks.set(url, mask);
    }
    if (mask === null) return true;
    const px = clamp(Math.floor(u * HIT_MASK_SIZE), 0, HIT_MASK_SIZE - 1), py = clamp(Math.floor(v * HIT_MASK_SIZE), 0, HIT_MASK_SIZE - 1);
    return mask[(py * HIT_MASK_SIZE + px) * 4 + 3] >= HIT_ALPHA_THRESHOLD;
  }
}
