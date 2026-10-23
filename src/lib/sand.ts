// Zen-garden sand as a height map. Raking writes a groove profile across the
// rake's width; shading lights the slopes from the top-left and darkens groove
// floors, so grooves read as relief at any angle. Stones cast shadows from
// the same light.

// r is the half-width; aspect is height/width, so the stone is an r by r*aspect oval.
export type Stone = { x: number; y: number; r: number; aspect: number };
export type Rgb = { r: number; g: number; b: number };

// The sand's colour and grain: an RGBA tile repeated across the garden.
export type SandTile = { w: number; h: number; data: Uint8ClampedArray };

const AMP = 1;
const GRAIN = 512;

// Stand-in grain for before the sand photo loads: fine noise, scattered
// darker and lighter grains, and soft mottling whose waves fit the tile
// exactly so the repeat has no seam.
export function grainTile(base: Rgb): SandTile {
  const data = new Uint8ClampedArray(GRAIN * GRAIN * 4);
  const rand = mulberry32(7);
  const k = (Math.PI * 2) / GRAIN;
  for (let y = 0; y < GRAIN; y++) {
    for (let x = 0; x < GRAIN; x++) {
      const mottle = (Math.sin(x * k * 3 + Math.sin(y * k * 2) * 1.5) + Math.sin((x + y) * k * 2)) * 0.012;
      const r = rand();
      let v = (rand() - 0.5) * 0.07 + mottle;
      if (r < 0.025) v -= 0.08 + rand() * 0.1;
      else if (r > 0.985) v += 0.07 + rand() * 0.06;
      const i = (y * GRAIN + x) * 4;
      data[i] = base.r * (1 + v);
      data[i + 1] = base.g * (1 + v);
      data[i + 2] = base.b * (1 + v);
      data[i + 3] = 255;
    }
  }
  return { w: GRAIN, h: GRAIN, data };
}

const TAU = Math.PI * 2;
// Samples spanned when reading a stroke end's direction (~12px at the garden's 3px step).
const LOOK = 4;

type Dir = { x: number; y: number };

// The way light travels across the garden, matched to the stone photos:
// both are lit from above, the large one from about 22° left of overhead
// and the small one 16° right. This is 15° left, favouring the large one.
// Slopes facing it are lit and shadows fall almost straight down.
const AWAY: Dir = { x: 0.26, y: 0.966 };
// How far a stone's shadow reaches past it, as a share of its half-width:
// a sun high enough that the shadow barely clears the stone.
const SHADOW_REACH = 0.3;

function unit(from: Dir, to: Dir): Dir | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  return len < 1e-3 ? null : { x: dx / len, y: dy / len };
}

// How much of the rake reaches offset (fx, fy) from its centre: 1 behind the
// bar, 0 past it. The bar's edge is ragged, as sand breaks unevenly where
// tines lift: noise along the bar pushes it forward and back by up to half a
// groove, at two scales, and the edge blends over a pixel or so. Only the
// rake-sized box around the bar is cut, so an older stretch of a looping
// stroke that lies ahead is left alone.
function behindBar(fx: number, fy: number, d: Dir, reach: number, spacing: number, seed: number) {
  const ahead = fx * d.x + fy * d.y;
  const along = fx * d.y - fy * d.x;
  if (ahead >= reach || Math.abs(along) >= reach) return 1;
  const jag =
    (noise(along / (spacing * 0.8), seed) * 0.65 + noise(along / (spacing * 0.25), seed + 1) * 0.35) * spacing * 0.5;
  const e = Math.min(1, Math.max(0, (jag - ahead) / 1.5 + 0.5));
  return e * e * (3 - 2 * e);
}

// Smooth 1D value noise in [-1, 1]; each seed gives a different line.
function noise(x: number, seed: number) {
  const i = Math.floor(x);
  const u = x - i;
  const a = hash(i, seed);
  return (a + (hash(i + 1, seed) - a) * u * u * (3 - 2 * u)) * 2 - 1;
}

function hash(i: number, seed: number) {
  let h = Math.imul(i ^ Math.imul(seed, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export class Sand {
  readonly w: number;
  readonly h: number;
  private readonly height: Float32Array;
  private readonly mask: Uint8Array;
  private readonly shadow: Float32Array; // 0 in full sun, 1 in full shadow
  private readonly slope: number;
  private tile!: SandTile;
  private tileCol!: Int32Array; // each column's byte offset into a tile row
  private dirty = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };

  // `scale` is how much larger the grooves are drawn. Stretching a groove
  // flattens its slopes by the same factor, so shading boosts them back and
  // the relief reads as deep as at life size. Horizontal grooves, the raked
  // starting state, catch the light through AWAY.y alone, so dividing by it
  // keeps their relief the same whichever way the light comes from.
  constructor(w: number, h: number, tile: SandTile, scale = 1) {
    this.w = w;
    this.h = h;
    this.slope = (0.078 / AWAY.y) * scale;
    this.height = new Float32Array(w * h);
    this.mask = new Uint8Array(w * h);
    this.shadow = new Float32Array(w * h);
    this.setTile(tile);
  }

  setTile(tile: SandTile) {
    this.tile = tile;
    this.tileCol = Int32Array.from({ length: this.w }, (_, x) => (x % tile.w) * 4);
    this.mark(0, 0, this.w - 1, this.h - 1);
  }

  get isDirty() {
    return this.dirty.x1 >= this.dirty.x0;
  }

  private mark(x0: number, y0: number, x1: number, y1: number) {
    const d = this.dirty;
    d.x0 = Math.min(d.x0, x0);
    d.y0 = Math.min(d.y0, y0);
    d.x1 = Math.max(d.x1, x1);
    d.y1 = Math.max(d.y1, y1);
  }

  // Straight lines across everything, the classic starting state.
  rakeStraight(spacing: number) {
    const { w, h, height } = this;
    for (let y = 0; y < h; y++) height.fill(AMP * Math.cos((TAU * y) / spacing), y * w, (y + 1) * w);
    this.mark(0, 0, w - 1, h - 1);
  }

  // Raking is a swept profile, not a stamp. A stroke is the rake centre's
  // path; every cell takes the groove profile for its distance to the
  // nearest point on the recent path. Tines are parallel offsets of that
  // path, so fast moves can't leave gaps and tight circles close into clean
  // rings instead of smearing. Heights blend against a snapshot taken when
  // the stroke began, so recomputing a cell is idempotent.
  //
  // The snapshot is lazy: a cell copies its height into `base` the first time
  // a stroke touches it (tracked by stroke id), so starting a stroke costs
  // nothing however big the garden is.
  private stroke: { pts: { x: number; y: number }[]; capStart: boolean } | null = null;
  private strokeId = 0;
  private strokeSeed = 0; // fixed for a whole stroke, unlike the id
  private base = new Float32Array(0);
  private owner = new Uint32Array(0);
  private best = new Float32Array(0);

  beginStroke(x: number, y: number) {
    if (this.base.length !== this.height.length) {
      this.base = new Float32Array(this.height.length);
      this.owner = new Uint32Array(this.height.length);
    }
    this.strokeId++;
    this.strokeSeed = this.strokeId * 2;
    this.stroke = { pts: [{ x, y }], capStart: true };
  }

  endStroke() {
    this.stroke = null;
  }

  extendStroke(next: { x: number; y: number }[], tines: number, spacing: number) {
    const s = this.stroke;
    if (!s || next.length === 0) return;
    const { w, h, height, mask } = this;
    const half = (tines * spacing) / 2;
    const reach = half + 1;
    // Long enough to wrap a full circle at the rake's own radius, so a tight
    // loop resolves against both sides of itself.
    const window = Math.ceil((Math.PI * 2 * half) / 3) + 12;

    // Drop history beyond the window. A new id makes cells re-snapshot, so
    // their base already includes everything raked so far.
    if (s.pts.length > window * 4) {
      s.pts = s.pts.slice(-window - 1);
      s.capStart = false;
      this.strokeId++;
    }

    const firstNew = s.pts.length - 1;
    for (const p of next) s.pts.push(p);
    const pts = s.pts;
    const n = pts.length;

    let rx0 = Infinity;
    let ry0 = Infinity;
    let rx1 = -Infinity;
    let ry1 = -Infinity;
    for (let i = firstNew; i < n; i++) {
      rx0 = Math.min(rx0, pts[i].x);
      ry0 = Math.min(ry0, pts[i].y);
      rx1 = Math.max(rx1, pts[i].x);
      ry1 = Math.max(ry1, pts[i].y);
    }
    rx0 = Math.max(0, Math.floor(rx0 - reach));
    ry0 = Math.max(0, Math.floor(ry0 - reach));
    rx1 = Math.min(w - 1, Math.ceil(rx1 + reach));
    ry1 = Math.min(h - 1, Math.ceil(ry1 + reach));
    if (rx1 < rx0 || ry1 < ry0) return;
    const rw = rx1 - rx0 + 1;
    const cells = rw * (ry1 - ry0 + 1);
    if (this.best.length < cells) this.best = new Float32Array(cells * 2);
    const best = this.best;
    best.fill(Infinity, 0, cells);
    const reach2 = reach * reach;

    // The rake is a straight bar across the path, so the stroke ends flat
    // along it instead of rounding off. Each end's direction spans a few
    // samples, so pointer jitter doesn't swing the bar.
    const head = pts[n - 1];
    const hd = unit(pts[Math.max(0, n - 1 - LOOK)], head);
    const tail = pts[0];
    const td = s.capStart ? unit(tail, pts[Math.min(n - 1, LOOK)]) : null;

    for (let i = Math.max(0, n - 1 - window); i < n - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-6) continue;
      const x0 = Math.max(rx0, Math.floor(Math.min(a.x, b.x) - reach));
      const x1 = Math.min(rx1, Math.ceil(Math.max(a.x, b.x) + reach));
      const y0 = Math.max(ry0, Math.floor(Math.min(a.y, b.y) - reach));
      const y1 = Math.min(ry1, Math.ceil(Math.max(a.y, b.y) + reach));
      for (let y = y0; y <= y1; y++) {
        const py = y - a.y;
        for (let x = x0; x <= x1; x++) {
          const px = x - a.x;
          const raw = (px * dx + py * dy) / len2;
          const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
          const qx = px - t * dx;
          const qy = py - t * dy;
          const d2 = qx * qx + qy * qy;
          if (d2 > reach2) continue;
          const j = (y - ry0) * rw + (x - rx0);
          if (d2 < best[j]) best[j] = d2;
        }
      }
    }

    const phase = Math.PI * (tines - 1);
    const feather = spacing * 0.5;
    const { base, owner, strokeId, strokeSeed } = this;
    for (let y = ry0; y <= ry1; y++) {
      for (let x = rx0; x <= rx1; x++) {
        const d2 = best[(y - ry0) * rw + (x - rx0)];
        if (d2 === Infinity) continue;
        const k = y * w + x;
        if (mask[k]) continue;
        const v = Math.sqrt(d2);
        if (v > half) continue;
        // Nothing ahead of the rake yet, and an edge where it started.
        let cut = 1;
        if (hd) cut = behindBar(x - head.x, y - head.y, hd, reach, spacing, strokeSeed);
        if (td) cut = Math.min(cut, behindBar(tail.x - x, tail.y - y, td, reach, spacing, strokeSeed + 1));
        if (cut <= 0) continue;
        // The profile is even in v, so which side of the path doesn't matter.
        const target = -AMP * Math.cos((TAU * v) / spacing + phase);
        const e = Math.min(1, (half - v) / feather);
        const wgt = e * e * (3 - 2 * e) * cut;
        if (owner[k] !== strokeId) {
          owner[k] = strokeId;
          base[k] = height[k];
        }
        height[k] = base[k] + (target - base[k]) * wgt;
      }
    }
    this.mark(rx0, ry0, rx1, ry1);
  }

  // Concentric ripples raked around a stone.
  ring(stone: Stone, spacing: number, count: number) {
    const { w, h, height, mask } = this;
    const inner = stone.r * 1.12;
    const width = count * spacing;
    const outer = inner + width;
    const x0 = Math.max(1, Math.floor(stone.x - outer));
    const x1 = Math.min(w - 2, Math.ceil(stone.x + outer));
    const y0 = Math.max(1, Math.floor(stone.y - outer));
    const y1 = Math.min(h - 2, Math.ceil(stone.y + outer));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const k = y * w + x;
        if (mask[k]) continue;
        // Distance out from the oval along the ray from its centre: hugs the
        // stone up close and rounds out into circles further away.
        const dx = x - stone.x;
        const dy = y - stone.y;
        const q = Math.hypot(dx / inner, dy / (inner * stone.aspect));
        const v = q ? Math.hypot(dx, dy) * (1 - 1 / q) : -inner;
        if (v < -spacing * 0.5 || v > width) continue;
        const target = AMP * Math.cos((TAU * v) / spacing);
        const a = Math.max(0, Math.min(1, (width - v) / (spacing * 0.75)));
        height[k] += (target - height[k]) * a;
      }
    }
    if (x1 >= x0 && y1 >= y0) this.mark(x0, y0, x1, y1);
  }

  // Grooves raked along the shore: parallel to `top` (the y where they begin
  // at each x) from there down to the waterline. Spacing is measured square
  // to the curve, so they keep their width where it slopes.
  rakeShore(top: (x: number) => number, shore: (x: number) => number, spacing: number) {
    const { w, h, height, mask } = this;
    let y0 = h;
    for (let x = 0; x < w; x++) {
      const t = top(x);
      const slope = (top(x + 1) - top(x - 1)) / 2;
      const across = 1 / Math.sqrt(1 + slope * slope);
      const from = Math.max(0, Math.floor(t - spacing));
      const to = Math.min(h - 1, Math.ceil(shore(x)));
      y0 = Math.min(y0, from);
      for (let y = from; y <= to; y++) {
        const k = y * w + x;
        if (mask[k]) continue;
        const v = (y - t) * across;
        // Fades in over the first groove, into the straight lines above.
        const a = Math.max(0, Math.min(1, (v + spacing * 0.5) / (spacing * 0.75)));
        height[k] += (AMP * Math.cos((TAU * v) / spacing) - height[k]) * a;
      }
    }
    if (y0 < h) this.mark(0, y0, w - 1, h - 1);
  }

  // The rake can't pass through a stone.
  buildMask(stones: Stone[]) {
    const { w, h, mask } = this;
    mask.fill(0);
    for (const s of stones) {
      const rx = s.r * 0.95;
      const ry = rx * s.aspect;
      for (let y = Math.max(0, Math.floor(s.y - ry)); y <= Math.min(h - 1, s.y + ry); y++) {
        for (let x = Math.max(0, Math.floor(s.x - rx)); x <= Math.min(w - 1, s.x + rx); x++) {
          if (((x - s.x) / rx) ** 2 + ((y - s.y) / ry) ** 2 <= 1) mask[y * w + x] = 1;
        }
      }
    }
  }

  // The shadow a stone casts, from its silhouette: `alpha` is the photo's
  // coverage at sand resolution, aw by ah, with its top-left at (ax, ay).
  // The silhouette is smeared away from the light, fading as it goes, then
  // blurred, so the shadow is darkest against the stone and softens with
  // distance. A tight blur of the bare silhouette adds the contact shadow
  // where stone meets sand, all the way round.
  castShadow(stone: Stone, alpha: Float32Array, aw: number, ah: number, ax: number, ay: number) {
    const reach = stone.r * SHADOW_REACH;
    const soft = Math.max(1, Math.round(stone.r * 0.11));
    const tight = Math.max(1, Math.round(stone.r * 0.035));
    const pad = Math.ceil(reach + 3 * soft);
    const bw = aw + pad * 2;
    const bh = ah + pad * 2;
    const sil = new Float32Array(bw * bh);
    for (let y = 0; y < ah; y++) sil.set(alpha.subarray(y * aw, (y + 1) * aw), (y + pad) * bw + pad);

    const cast = new Float32Array(bw * bh);
    const steps = Math.max(1, Math.ceil(reach / 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const ox = Math.round(AWAY.x * reach * t);
      const oy = Math.round(AWAY.y * reach * t);
      const fade = 1 - 0.3 * t;
      for (let y = oy; y < bh; y++) {
        const src = (y - oy) * bw - ox;
        const dst = y * bw;
        for (let x = ox; x < bw; x++) {
          const v = sil[src + x] * fade;
          if (v > cast[dst + x]) cast[dst + x] = v;
        }
      }
    }
    blur(cast, bw, bh, soft);
    blur(sil, bw, bh, tight);

    const { w, h, shadow } = this;
    const x0 = ax - pad;
    const y0 = ay - pad;
    for (let y = Math.max(0, -y0); y < Math.min(bh, h - y0); y++) {
      for (let x = Math.max(0, -x0); x < Math.min(bw, w - x0); x++) {
        const j = y * bw + x;
        const v = 1 - (1 - 0.45 * cast[j]) * (1 - 0.4 * sil[j]);
        const k = (y0 + y) * w + x0 + x;
        if (v > shadow[k]) shadow[k] = v;
      }
    }
    this.mark(Math.max(0, x0), Math.max(0, y0), Math.min(w - 1, x0 + bw - 1), Math.min(h - 1, y0 + bh - 1));
  }

  // Lights the dirty region (or everything) into img; returns the rectangle
  // written. Shadow takes away the direct light, which is what shows the
  // grooves' slopes, so they flatten but don't vanish; what's left is cooler
  // skylight.
  shade(img: ImageData, full = false) {
    const { w, h, height, tile, tileCol, slope, shadow } = this;
    const tex = tile.data;
    const d = full ? { x0: 0, y0: 0, x1: w - 1, y1: h - 1 } : this.dirty;
    const x0 = Math.max(0, d.x0 - 1);
    const y0 = Math.max(0, d.y0 - 1);
    const x1 = Math.min(w - 1, d.x1 + 1);
    const y1 = Math.min(h - 1, d.y1 + 1);
    const data = img.data;
    for (let y = y0; y <= y1; y++) {
      const up = y > 0 ? -w : 0;
      const down = y < h - 1 ? w : 0;
      const row = (y % tile.h) * tile.w * 4;
      for (let x = x0; x <= x1; x++) {
        const k = y * w + x;
        const gx = height[k + (x < w - 1 ? 1 : 0)] - height[k - (x > 0 ? 1 : 0)];
        const gy = height[k + down] - height[k + up];
        const a = shadow[k];
        const lit = 1 + (gx * AWAY.x + gy * AWAY.y) * slope * (1 - 0.7 * a) + height[k] * 0.07;
        const s = lit * (1 - 0.3 * a);
        const t = row + tileCol[x];
        const i = k * 4;
        data[i] = tex[t] * s * (1 - 0.05 * a);
        data[i + 1] = tex[t + 1] * s;
        data[i + 2] = tex[t + 2] * s * (1 + 0.1 * a);
        data[i + 3] = 255;
      }
    }
    this.dirty = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
}

// Where a stone's photo goes: centred on the stone, its long side spanning
// just over the stone's diameter.
export function stoneBox({ x, y, r, aspect }: Stone) {
  const w = r * 2.08;
  const h = w * aspect;
  return { x: x - w / 2, y: y - h / 2, w, h };
}

// The photo, ringed by a thin dark rim where it sits down into the sand.
// The cast shadow is part of the sand (Sand.castShadow); the rim is drawn
// here, at the stone layer's full resolution, so it stays crisp. Canvas
// shadows ignore the transform, so their sizes are scaled by it by hand.
export function drawStone(ctx: CanvasRenderingContext2D, stone: Stone, img: HTMLImageElement) {
  const b = stoneBox(stone);
  const px = ctx.getTransform().a;
  ctx.save();
  ctx.shadowColor = "rgba(46, 34, 18, 0.75)";
  ctx.shadowBlur = Math.max(2, stone.r * 0.03) * px;
  ctx.shadowOffsetY = stone.r * 0.006 * px;
  ctx.drawImage(img, b.x, b.y, b.w, b.h);
  ctx.restore();
}

// Three box blurs in place, which together approximate a Gaussian of about
// radius r; values beyond the edges count as zero.
function blur(a: Float32Array, w: number, h: number, r: number) {
  const line = new Float32Array(Math.max(w, h));
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) boxLine(a, y * w, 1, w, r, line);
    for (let x = 0; x < w; x++) boxLine(a, x, w, h, r, line);
  }
}

function boxLine(a: Float32Array, start: number, stride: number, n: number, r: number, line: Float32Array) {
  for (let i = 0; i < n; i++) line[i] = a[start + i * stride];
  let sum = 0;
  for (let i = 0; i <= Math.min(r, n - 1); i++) sum += line[i];
  const d = 2 * r + 1;
  for (let i = 0; i < n; i++) {
    a[start + i * stride] = sum / d;
    if (i + r + 1 < n) sum += line[i + r + 1];
    if (i - r >= 0) sum -= line[i - r];
  }
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
