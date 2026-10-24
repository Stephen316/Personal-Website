// Koi: each fish is a chain of spine points dragged behind its head, so turns
// bend the body naturally. Heads steer toward a point circling the cursor.
// A cursor swept fast over a fish startles it: it flicks round and darts
// away, nearby fish panic with it, and after staying wary for a few seconds
// each one drifts back on its own.
// Each is assembled from sprite parts (see public/koi): the body bends along
// the spine, the tail fin flexes behind it, and the fins stay rigid.

type P = { x: number; y: number };

export type Koi = {
  pts: P[];
  angle: number;
  speed: number;
  seg: number;
  width: number; // body width, used for spacing and the shore margin
  kind: number; // row in the koi atlas
  phase: number;
  orbit: number;
  orbitR: number;
  fear: number; // seconds of fleeing left
  wary: number; // seconds left before it will come back to the cursor
  flee: P; // unit direction it's fleeing in
  exit: number; // -1 or 1 once it's leaving the pond off that side, else 0
};

const SEGMENTS = 14;

// Fish live in page coordinates, so they scroll with the pond. y0..y1 is the
// band they start in; one fish per kind in the atlas.
export function makeSchool(count: number, w: number, y0: number, y1: number, scale: number, rand: () => number): Koi[] {
  return Array.from({ length: count }, (_, i) => {
    const len = (115 + rand() * 45) * scale;
    const seg = len / (SEGMENTS - 1);
    const x = w * (0.15 + rand() * 0.7);
    const y = y0 + rand() * (y1 - y0);
    const angle = rand() * Math.PI * 2;
    return {
      pts: Array.from({ length: SEGMENTS }, (_, k) => ({ x: x - Math.cos(angle) * seg * k, y: y - Math.sin(angle) * seg * k })),
      angle,
      speed: 40,
      seg,
      width: len * 0.24,
      kind: i,
      phase: rand() * 10,
      orbit: (i / count) * Math.PI * 2,
      orbitR: (50 + rand() * 70) * scale,
      fear: 0,
      wary: 0,
      flee: { x: 1, y: 0 },
      exit: 0,
    };
  });
}

// The pond in page coordinates: top(x) is the shoreline, bottom the end of
// the page, and view the part of the page currently on screen.
export type Water = { w: number; top: (x: number) => number; bottom: number; view: { y0: number; y1: number } };

// The cursor in page coordinates, with how fast it's moving (px/s).
export type Cursor = P & { speed: number };

// Sent when the page opens a project: every fish darts off the nearer side.
export const SCATTER_EVENT = "koi:scatter";
const EXIT_SPEED = 950; // px/s

export function scatter(school: Koi[], w: number) {
  for (const f of school) {
    f.exit = f.pts[0].x < w / 2 ? -1 : 1;
    f.fear = 3;
    f.wary = Infinity;
    f.speed = Math.max(f.speed, 320);
  }
}

const STARTLE_SPEED = 1700; // px/s, averaged; a brisk flick, not ordinary movement

function startle(f: Koi, from: P, strength: number) {
  if (f.fear > 0.3) return;
  const head = f.pts[0];
  let dx = head.x - from.x;
  let dy = head.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  // Away from the threat, off by a random angle so the school splits.
  const a = Math.atan2(dy / d, dx / d) + (Math.random() - 0.5) * 1.1;
  dx = Math.cos(a);
  dy = Math.sin(a);
  f.flee = { x: dx, y: dy };
  f.fear = (1 + Math.random() * 0.8) * strength;
  f.wary = f.fear + 2.5 + Math.random() * 3;
  f.speed = Math.max(f.speed, 260 * strength);
}

// Distance from p to the nearest spine point of a fish.
function nearest(f: Koi, p: P) {
  let best = Infinity;
  for (let i = 0; i < f.pts.length; i += 3) best = Math.min(best, Math.hypot(f.pts[i].x - p.x, f.pts[i].y - p.y));
  return best;
}

export function updateSchool(school: Koi[], cursor: Cursor | null, water: Water, t: number, dt: number) {
  const { w, top, bottom, view } = water;

  // Startles first, so panic can spread through the school in one frame.
  if (cursor && cursor.speed > STARTLE_SPEED) {
    // The cursor has to pass over or right beside the body; a faster flick
    // reaches a little further.
    const reach = Math.min(1, (cursor.speed - STARTLE_SPEED) / 2000) * 40;
    for (const f of school) {
      if (f.fear === 0 && nearest(f, cursor) < f.width + reach) {
        startle(f, cursor, 1);
        // Neighbours usually catch the panic, more weakly.
        for (const o of school) {
          if (o !== f && Math.random() < 0.75 && nearest(o, f.pts[0]) < f.width * 4) startle(o, f.pts[0], 0.7);
        }
      }
    }
  }

  for (const f of school) {
    const head = f.pts[0];
    const margin = f.width * 2 + 24;
    f.fear = Math.max(0, f.fear - dt);
    f.wary = Math.max(0, f.wary - dt);
    const target = f.wary > 0 ? null : cursor;
    let tx: number;
    let ty: number;
    if (f.exit) {
      tx = head.x + f.exit * 600;
      ty = head.y;
    } else if (f.fear > 0) {
      tx = head.x + f.flee.x * 400;
      ty = head.y + f.flee.y * 400;
    } else if (target) {
      // Each fish circles its own spot round the cursor, so they don't pile up.
      const a = f.orbit + t * 0.35;
      tx = target.x + Math.cos(a) * f.orbitR;
      ty = target.y + Math.sin(a) * f.orbitR;
    } else {
      // Wander: drift toward a slowly moving point in the water on screen.
      tx = w * (0.5 + 0.35 * Math.cos(t * 0.11 + f.orbit * 2));
      ty = view.y0 + (view.y1 - view.y0) * (0.5 + 0.3 * Math.sin(t * 0.13 + f.orbit * 3));
    }
    // A cursor over the sand draws them to the water's edge, not under it.
    ty = Math.min(bottom - margin, Math.max(ty, top(tx) + margin));
    const gx = tx - head.x;
    const gy = ty - head.y;
    const dist = Math.hypot(gx, gy) || 1;
    let vx = gx / dist;
    let vy = gy / dist;

    // Keep a little space from the others.
    for (const o of school) {
      if (o === f) continue;
      const dx = head.x - o.pts[0].x;
      const dy = head.y - o.pts[0].y;
      const d = Math.hypot(dx, dy);
      if (d > 0 && d < f.width * 3) {
        vx += (dx / d) * 0.6;
        vy += (dy / d) * 0.6;
      }
    }

    // Turn away from the shore as it gets close.
    const gap = head.y - top(head.x);
    if (gap < 110) vy += ((110 - gap) / 110) * 2.5;

    const want = Math.atan2(vy, vx);
    let diff = (want - f.angle) % (Math.PI * 2);
    if (diff > Math.PI) diff -= Math.PI * 2;
    if (diff < -Math.PI) diff += Math.PI * 2;
    // A koi can't turn tighter than about half its length, however slowly
    // it's swimming, so the turn rate is capped by speed / minimum radius.
    // A startled fish snaps round much harder (the escape "C-start").
    const scared = f.fear > 0;
    const minRadius = f.seg * (f.pts.length - 1) * (scared ? 0.3 : 0.55);
    const turn = Math.min(scared ? 7 : 2.6, Math.max(f.speed, 20) / minRadius) * dt;
    f.angle += Math.max(-turn, Math.min(turn, diff));

    // Fleeing fish burst and then coast down; wary ones dawdle; calm ones
    // close in on the cursor.
    const cruise = f.exit ? EXIT_SPEED : scared ? 120 + 200 * Math.min(1, f.fear) : target ? Math.min(170, 35 + dist * 0.55) : f.wary > 0 ? 30 : 38;
    f.speed += (cruise - f.speed) * Math.min(1, dt * (f.exit ? 4 : scared ? 2.5 : 1.5));
    head.x += Math.cos(f.angle) * f.speed * dt;
    head.y += Math.sin(f.angle) * f.speed * dt;
    if (!f.exit) head.x = Math.max(-60, Math.min(w + 60, head.x));
    head.y = Math.min(bottom - f.width, Math.max(head.y, top(head.x) + f.width * 0.6));

    for (let i = 1; i < f.pts.length; i++) {
      const a = f.pts[i - 1];
      const b = f.pts[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      b.x = a.x + (dx / d) * f.seg;
      b.y = a.y + (dy / d) * f.seg;
    }
    f.phase += dt * (3 + f.speed * 0.04);
  }
}

type Frame = { x: number; y: number; tx: number; ty: number };

// Spine with a travelling side-to-side wave that grows toward the tail.
function frames(f: Koi): Frame[] {
  const n = f.pts.length;
  return f.pts.map((p, i) => {
    const a = f.pts[Math.max(0, i - 1)];
    const b = f.pts[Math.min(n - 1, i + 1)];
    let tx = a.x - b.x;
    let ty = a.y - b.y;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl;
    ty /= tl;
    const t = i / (n - 1);
    const sway = Math.sin(f.phase - t * 4) * f.width * 0.16 * t * t;
    return { x: p.x - ty * sway, y: p.y + tx * sway, tx, ty };
  });
}

// Vertical extent of the school in page coordinates, fins included.
export function schoolBounds(school: Koi[]) {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const f of school) {
    for (const p of f.pts) {
      x0 = Math.min(x0, p.x - f.width * 2);
      x1 = Math.max(x1, p.x + f.width * 2);
      y0 = Math.min(y0, p.y - f.width * 2);
      y1 = Math.max(y1, p.y + f.width * 2);
    }
  }
  return { x0, x1, y0, y1 };
}

// ---------------------------------------------------------------------------
// The 2D rig. Each koi is a set of parts cut from one sprite sheet: a body,
// nose at the left, laid along the spine as a strip of quads only as wide as
// the body, so it bends without folding over; a tail fin continuing from the
// tail base as a short chain that lags the body's wave, so it flexes; and
// rigid pectoral and pelvic fins pinned to the body's sides, mirrored for the
// far side, that paddle a little and fold back when the fish bolts. Fins and
// tail go down first so the body covers their roots. Vertices are page px
// plus atlas UVs, written as plain triangles.

const BODY_SEGS = 20;
const TAIL_SEGS = 6;
const FINS = 4;
export const KOI_FLOATS_PER_FISH = (BODY_SEGS + TAIL_SEGS + FINS) * 6 * 4;

// The tail fin's root is a stub of peduncle: its first TAIL_TUCK (of the fin's
// length) tucks under the body, and the stub, a little taller than the body's
// tail base on the sheets, narrows to TAIL_ROOT of the fin's height there,
// widening to full by TAIL_FLARE.
const TAIL_TUCK = 0.1;
const TAIL_ROOT = 0.69;
const TAIL_FLARE = 0.25;

// Where each fin pair is pinned: distance from the nose as a share of the
// body, how far out toward the body's edge, and the angle out from straight
// back (radians).
const PEC = { at: 0.24, out: 0.72, angle: 0.85 };
const PELVIC = { at: 0.5, out: 0.78, angle: 0.5 };

// One part's place in the atlas (UV space): its height/length ratio, and its
// length relative to the body's (every part is cut at the same scale).
export type KoiPart = { u0: number; v0: number; u1: number; v1: number; aspect: number; rel: number };
export type KoiKind = { body: KoiPart; tail: KoiPart; pec: KoiPart; pelvic: KoiPart };

export function writeKoiMesh(school: Koi[], kinds: KoiKind[], out: Float32Array) {
  let o = 0;
  const put = (x: number, y: number, u: number, v: number) => {
    out[o++] = x;
    out[o++] = y;
    out[o++] = u;
    out[o++] = v;
  };
  // A quad from the (a0, a1) end at u0 to the (b0, b1) end at u1; the 0 corners
  // take the part's top row, the 1 corners its bottom.
  const quad = (a0: P, a1: P, u0: number, b0: P, b1: P, u1: number, r: KoiPart) => {
    put(a0.x, a0.y, u0, r.v0);
    put(b0.x, b0.y, u1, r.v0);
    put(a1.x, a1.y, u0, r.v1);
    put(b0.x, b0.y, u1, r.v0);
    put(b1.x, b1.y, u1, r.v1);
    put(a1.x, a1.y, u0, r.v1);
  };
  const off = (p: P, n: P, k: number) => ({ x: p.x + n.x * k, y: p.y + n.y * k });

  for (const f of school) {
    const kind = kinds[f.kind % kinds.length];
    const fr = frames(f);

    // Render spine. The head of a koi is rigid and the bend happens behind
    // the pectoral fins, so the front third is pulled toward a straight line
    // along the head's heading, then the whole line is relaxed so no single
    // joint kinks.
    const head = fr[0];
    const n = fr.length;
    const spine: P[] = fr.map((q, i) => {
      const t = i / (n - 1);
      const stiff = t < 0.38 ? 1 - t / 0.38 : 0;
      const w = stiff * stiff * (3 - 2 * stiff);
      const d = f.seg * i;
      return { x: q.x + (head.x - head.tx * d - q.x) * w, y: q.y + (head.y - head.ty * d - q.y) * w };
    });
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < n - 1; i++) {
        spine[i] = {
          x: spine[i].x * 0.5 + (spine[i - 1].x + spine[i + 1].x) * 0.25,
          y: spine[i].y * 0.5 + (spine[i - 1].y + spine[i + 1].y) * 0.25,
        };
      }
    }
    const snout = f.seg * (n - 1) * 0.02;
    spine.unshift({ x: head.x + head.tx * snout, y: head.y + head.ty * snout });
    const cum = [0];
    for (let i = 1; i < spine.length; i++) cum.push(cum[i - 1] + Math.hypot(spine[i].x - spine[i - 1].x, spine[i].y - spine[i - 1].y));
    const len = cum[cum.length - 1];
    // The point d along the spine, its normal, and the way back toward the tail.
    const at = (d: number) => {
      let i = 1;
      while (i < spine.length - 1 && cum[i] < d) i++;
      const a = spine[i - 1];
      const b = spine[i];
      const seg = cum[i] - cum[i - 1] || 1;
      const k = Math.max(0, Math.min(1, (d - cum[i - 1]) / seg));
      const bx = (b.x - a.x) / seg;
      const by = (b.y - a.y) / seg;
      return { p: { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }, n: { x: by, y: -bx }, back: { x: bx, y: by } };
    };
    const half = (len * kind.body.aspect) / 2;

    // Fins, rigid, each pinned inside the body's edge so the body covers its
    // root. The near and far fins mirror each other: each fin's top row faces
    // the head.
    const fin = (r: KoiPart, spot: { at: number; out: number; angle: number }, side: number, swing: number) => {
      const s = at(len * spot.at);
      const root = off(s.p, s.n, side * half * spot.out);
      const a = spot.angle + swing;
      const d = { x: s.back.x * Math.cos(a) + s.n.x * side * Math.sin(a), y: s.back.y * Math.cos(a) + s.n.y * side * Math.sin(a) };
      let m = { x: -d.y, y: d.x };
      if (m.x * s.back.x + m.y * s.back.y > 0) m = { x: -m.x, y: -m.y };
      const l = len * r.rel;
      const w = (l * r.aspect) / 2;
      const tip = off(root, d, l);
      quad(off(root, m, w), off(root, m, -w), r.u0, off(tip, m, w), off(tip, m, -w), r.u1, r);
    };
    // A bolting fish folds its fins back; otherwise they paddle slowly.
    const fold = 1 - 0.55 * Math.min(1, f.fear);
    for (const side of [-1, 1]) {
      fin(kind.pelvic, PELVIC, side, (Math.sin(f.phase * 0.4 + side) * 0.12 - PELVIC.angle * (1 - fold)));
      fin(kind.pec, PEC, side, (Math.sin(f.phase * 0.45 + side * 0.7) * 0.2 - PEC.angle * (1 - fold)));
    }

    // Tail fin: a chain from just inside the tail base, lagging the wave.
    const tr = kind.tail;
    const tailLen = len * tr.rel;
    const base = at(len - tailLen * TAIL_TUCK);
    let ang = Math.atan2(base.back.y, base.back.x);
    const sweep = Math.sin(f.phase - 4.6) * 0.5;
    const step = tailLen / TAIL_SEGS;
    const tailHalf = (tailLen * tr.aspect) / 2;
    const width = (u: number) => {
      const k = Math.min(1, u / TAIL_FLARE);
      return tailHalf * (TAIL_ROOT + (1 - TAIL_ROOT) * k * k * (3 - 2 * k));
    };
    let p = base.p;
    for (let k = 0; k < TAIL_SEGS; k++) {
      const n0 = { x: Math.sin(ang), y: -Math.cos(ang) };
      ang += (sweep / TAIL_SEGS) * (1 + k * 0.3);
      const q = { x: p.x + Math.cos(ang) * step, y: p.y + Math.sin(ang) * step };
      const n1 = { x: Math.sin(ang), y: -Math.cos(ang) };
      const t0 = k / TAIL_SEGS;
      const t1 = (k + 1) / TAIL_SEGS;
      const h0 = width(t0);
      const h1 = width(t1);
      quad(off(p, n0, h0), off(p, n0, -h0), tr.u0 + (tr.u1 - tr.u0) * t0, off(q, n1, h1), off(q, n1, -h1), tr.u0 + (tr.u1 - tr.u0) * t1, tr);
      p = q;
    }

    // Body. On the inside of a tight bend an edge could still run backwards
    // (the strip folding over itself); where it would, that edge point is
    // pulled in toward the spine until it moves forward again. The strip is
    // only body-wide, so this is rare.
    const br = kind.body;
    const samples = Array.from({ length: BODY_SEGS + 1 }, (_, i) => at((i / BODY_SEGS) * len));
    const edge = (side: number) => {
      const pts = samples.map((s) => off(s.p, s.n, half * side));
      for (let i = 1; i < pts.length; i++) {
        const sx = samples[i].p.x - samples[i - 1].p.x;
        const sy = samples[i].p.y - samples[i - 1].p.y;
        for (let k = 0.6; k > 0.05; k *= 0.5) {
          const ex = pts[i].x - pts[i - 1].x;
          const ey = pts[i].y - pts[i - 1].y;
          if (ex * sx + ey * sy > 0.15 * (sx * sx + sy * sy)) break;
          pts[i] = off(samples[i].p, samples[i].n, half * side * k);
        }
      }
      return pts;
    };
    // n points to the sheet's top edge when the fish lies as drawn (nose left).
    const top = edge(1);
    const bottom = edge(-1);
    for (let i = 0; i < BODY_SEGS; i++) {
      const u0 = br.u0 + ((br.u1 - br.u0) * i) / BODY_SEGS;
      const u1 = br.u0 + ((br.u1 - br.u0) * (i + 1)) / BODY_SEGS;
      quad(top[i], bottom[i], u0, top[i + 1], bottom[i + 1], u1, br);
    }
  }
  return o / 4;
}
