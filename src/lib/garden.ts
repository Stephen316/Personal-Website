import { drawStone, grainTile, Sand, stoneBox, type SandTile, type Stone } from "./sand";

export const SAND = { r: 211, g: 183, b: 144 }; // the sand photo's mean colour
// How much larger than life-size the garden is drawn: the stones, and the
// sand (grooves, rake and grain) separately.
const STONE_SCALE = 1.5;
const SAND_SCALE = 1.3;
const SPACING = 13 * SAND_SCALE;
const TINES = 7;

// Aspect is height/width of each cropped photo in public/stones.
const STONE_IMAGES = [
  { src: "/stones/stone-1.webp", aspect: 783 / 1024 },
  { src: "/stones/stone-2.webp", aspect: 945 / 1024 },
];

const RINGS = 4;

// Two mossy stones within the first screen of sand, clear of the hero text,
// the screen edges and the shoreline below. vh is the viewport height and
// textRight is where the hero title ends: the stones sit beside the title,
// shifted right as far as the big one's ripples need to clear it, and fall
// back to above and below it only when the stone would then leave the
// screen. `img` indexes STONE_IMAGES.
function layoutStones(w: number, vh: number, textRight: number): (Stone & { img: number })[] {
  const s = Math.min(w, vh) / 900;
  const at = (x: number, y: number, r: number, img: number) => ({
    x,
    y,
    r: r * STONE_SCALE,
    img,
    aspect: STONE_IMAGES[img].aspect,
  });
  const big = at(w * 0.76, vh * 0.34, 110 * s + 18, 0);
  const shift = Math.max(0, textRight + 12 + ripples(big) - big.x);
  if (big.x + shift + big.r * 1.12 + SPACING <= w) {
    const placed = { ...big, x: big.x + shift };
    return [placed, apart(placed, at(w * 0.64 + shift, vh * 0.7, 66 * s + 15, 1))];
  }
  const top = at(w * 0.62, vh * 0.16, 54 * s + 22, 0);
  return [top, apart(top, at(w * 0.36, vh * 0.86, 42 * s + 18, 1))];
}

// How far a stone's outermost ripple reaches from its centre.
function ripples(s: Stone) {
  return s.r * 1.12 + RINGS * SPACING;
}

// Moves b straight away from a until their ripples no longer overlap, so
// neither stone's rings are raked through the other's.
function apart<T extends Stone>(a: Stone, b: T): T {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const need = ripples(a) + ripples(b);
  if (d >= need || d === 0) return b;
  return { ...b, x: a.x + (dx / d) * need, y: a.y + (dy / d) * need };
}

// The grain tile drawn SAND_SCALE times larger. Each side is rounded to whole
// pixels, so the tile still repeats without a seam.
function scaleTile(src: HTMLImageElement | HTMLCanvasElement): SandTile | null {
  const sw = src instanceof HTMLImageElement ? src.naturalWidth : src.width;
  const sh = src instanceof HTMLImageElement ? src.naturalHeight : src.height;
  const c = document.createElement("canvas");
  c.width = Math.round(sw * SAND_SCALE);
  c.height = Math.round(sh * SAND_SCALE);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return { w: c.width, h: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data };
}

// The stone's silhouette at sand resolution: its photo's alpha, drawn where
// drawStone puts it and snapped to whole sand cells.
function footprint(s: Stone, photo: HTMLImageElement) {
  const b = stoneBox(s);
  const x = Math.floor(b.x);
  const y = Math.floor(b.y);
  const w = Math.ceil(b.x + b.w) - x;
  const h = Math.ceil(b.y + b.h) - y;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(photo, b.x - x, b.y - y, b.w, b.h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < alpha.length; i++) alpha[i] = px[i * 4 + 3] / 255;
  return { alpha, w, h, x, y };
}

function grainCanvas(tile: SandTile) {
  const c = document.createElement("canvas");
  c.width = tile.w;
  c.height = tile.h;
  c.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(tile.data), tile.w, tile.h), 0, 0);
  return c;
}

// Hovering rakes the sand. The sand scrolls with the page, so everything
// here is in document coordinates: `size` is the sand's extent and `canRake`
// says whether a document point is on sand (above the shoreline), and
// `textRight` is the x where the hero title ends.
export function startGarden(
  sandCanvas: HTMLCanvasElement,
  stoneCanvas: HTMLCanvasElement,
  size: () => { w: number; h: number },
  canRake: (x: number, y: number) => boolean,
  textRight: () => number,
) {
  const sandCtx = sandCanvas.getContext("2d");
  const stoneCtx = stoneCanvas.getContext("2d");
  if (!sandCtx || !stoneCtx) return () => {};

  let sand: Sand;
  let img: ImageData;
  let stones: ReturnType<typeof layoutStones> = [];
  const grain = grainTile(SAND);
  let tile: SandTile = scaleTile(grainCanvas(grain)) ?? grain;

  // The sand photo is a seamless tile, scaled so its grains sit at a true
  // size beside the stones. It replaces the stand-in grain once decoded.
  const sandPhoto = new Image();
  sandPhoto.decoding = "async";
  sandPhoto.src = "/sand.webp";
  const onSandPhoto = () => {
    const scaled = scaleTile(sandPhoto);
    if (!scaled) return;
    tile = scaled;
    sand.setTile(tile);
    if (!raf) raf = requestAnimationFrame(paint);
  };
  sandPhoto.addEventListener("load", onSandPhoto);

  // The photos load after the first build, so stones are redrawn as each arrives.
  const photos = STONE_IMAGES.map(({ src }) => {
    const photo = new Image();
    photo.decoding = "async";
    photo.src = src;
    return photo;
  });
  const drawStones = () => {
    stoneCtx.clearRect(0, 0, stoneCanvas.width, stoneCanvas.height);
    for (const s of stones) {
      const photo = photos[s.img];
      if (photo.complete && photo.naturalWidth) drawStone(stoneCtx, s, photo);
    }
  };
  // A shadow needs its stone's silhouette, so each stone casts once its photo
  // is in, and again whenever a rebuild makes fresh sand.
  let shadowed = new Set<number>();
  const castShadows = () => {
    stones.forEach((s, i) => {
      const photo = photos[s.img];
      if (shadowed.has(i) || !photo.complete || !photo.naturalWidth) return;
      const f = footprint(s, photo);
      if (!f) return;
      sand.castShadow(s, f.alpha, f.w, f.h, f.x, f.y);
      shadowed.add(i);
    });
  };
  const onStonePhoto = () => {
    drawStones();
    castShadows();
    if (!raf) raf = requestAnimationFrame(paint);
  };
  for (const photo of photos) photo.addEventListener("load", onStonePhoto);

  const build = () => {
    const { w, h } = size();
    const dpr = Math.min(devicePixelRatio, 2);
    sandCanvas.width = w;
    sandCanvas.height = h;
    stoneCanvas.width = w * dpr;
    stoneCanvas.height = h * dpr;
    sand = new Sand(w, h, tile, SAND_SCALE);
    img = sandCtx.createImageData(w, h);
    stones = layoutStones(w, innerHeight, textRight());
    sand.buildMask(stones);
    sand.rakeStraight(SPACING);
    for (const s of stones) sand.ring(s, SPACING, RINGS);
    shadowed = new Set();
    castShadows();
    const r = sand.shade(img, true);
    sandCtx.putImageData(img, 0, 0, r.x, r.y, r.w, r.h);
    stoneCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawStones();
  };
  build();

  // Samples queue up and are raked once per frame: a fast mouse can deliver
  // several coalesced samples per frame, and each rake pass is a full sweep.
  let pending: { x: number; y: number }[] = [];
  let raf = 0;
  const paint = () => {
    raf = 0;
    if (pending.length) {
      sand.extendStroke(pending, TINES, SPACING);
      pending = [];
    }
    if (!sand.isDirty) return;
    const r = sand.shade(img);
    sandCtx.putImageData(img, 0, 0, r.x, r.y, r.w, r.h);
  };

  // The stroke path is smoothed through the pointer samples (quadratic
  // curves between midpoints, with each sample as the control point) and
  // resampled every STEP px, so sparse samples from a fast flick still give
  // a smooth curve rather than a polyline.
  type Pt = { x: number; y: number };
  let raw: Pt | null = null; // latest sample: the next curve's control point
  let mid: Pt | null = null; // where the drawn path currently ends
  let carry = 0; // arc length since the last emitted point
  const STEP = 3;

  // A sharp reversal would otherwise be smoothed into a hairpin, which a
  // rake this wide sweeps as a big half circle. Past CORNER the rake is
  // lifted at the turn and set down facing the new way: the stroke runs
  // straight to the corner, ends there, and a new one starts from it.
  // Heading is measured over HEADING_MIN px so hand jitter can't fake a turn.
  const CORNER = Math.cos((115 * Math.PI) / 180);
  const HEADING_MIN = 6;
  let heading: Pt | null = null;
  let anchor: Pt | null = null;

  const end = () => {
    if (pending.length) sand.extendStroke(pending, TINES, SPACING);
    pending = [];
    raw = null;
    mid = null;
    heading = null;
    anchor = null;
    sand.endStroke();
  };

  const corner = (c: Pt, from: Pt) => {
    const d = Math.hypot(c.x - from.x, c.y - from.y);
    const n = Math.ceil(d);
    for (let i = 1; i <= n; i++) {
      carry += d / n;
      if (carry >= STEP || i === n) {
        pending.push({ x: from.x + ((c.x - from.x) * i) / n, y: from.y + ((c.y - from.y) * i) / n });
        carry = 0;
      }
    }
    if (pending.length) sand.extendStroke(pending, TINES, SPACING);
    pending = [];
    sand.endStroke();
    sand.beginStroke(c.x, c.y);
    raw = c;
    mid = c;
  };

  const add = (p: Pt) => {
    if (!raw || !mid) {
      raw = p;
      mid = p;
      anchor = p;
      heading = null;
      carry = 0;
      sand.beginStroke(p.x, p.y);
      return;
    }
    if (Math.hypot(p.x - raw.x, p.y - raw.y) < 0.5) return;
    if (anchor) {
      const hx = p.x - anchor.x;
      const hy = p.y - anchor.y;
      const hd = Math.hypot(hx, hy);
      if (hd >= HEADING_MIN) {
        const h = { x: hx / hd, y: hy / hd };
        if (heading && heading.x * h.x + heading.y * h.y < CORNER) corner(raw, mid);
        heading = h;
        anchor = p;
      }
    }
    const next = { x: (raw.x + p.x) / 2, y: (raw.y + p.y) / 2 };
    const out: Pt[] = [];
    const approx = Math.hypot(raw.x - mid.x, raw.y - mid.y) + Math.hypot(next.x - raw.x, next.y - raw.y);
    const n = Math.max(2, Math.ceil(approx));
    let prev = mid;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const u = 1 - t;
      const q = {
        x: u * u * mid.x + 2 * u * t * raw.x + t * t * next.x,
        y: u * u * mid.y + 2 * u * t * raw.y + t * t * next.y,
      };
      carry += Math.hypot(q.x - prev.x, q.y - prev.y);
      if (carry >= STEP) {
        out.push(q);
        carry = 0;
      }
      prev = q;
    }
    mid = next;
    raw = p;
    for (const q of out) pending.push(q);
  };

  const onMove = (e: PointerEvent) => {
    const top = scrollY;
    if (!canRake(e.clientX, e.clientY + top)) {
      if (raw) end();
      return;
    }
    // Teleports (pointer left and came back elsewhere) start a fresh stroke.
    if (raw && Math.hypot(e.clientX - raw.x, e.clientY + top - raw.y) > 450) end();
    // Coalesced events carry the samples the browser merged between frames.
    const samples = e.getCoalescedEvents?.() ?? [];
    if (samples.length) for (const c of samples) add({ x: c.clientX, y: c.clientY + top });
    else add({ x: e.clientX, y: e.clientY + top });
    if (!raf) raf = requestAnimationFrame(paint);
  };
  const onLeave = () => end();
  addEventListener("pointermove", onMove, { passive: true });
  document.documentElement.addEventListener("mouseleave", onLeave);
  // Scrolling moves content, not the pointer, so the next move must not draw a jump.
  addEventListener("scroll", onLeave, { passive: true });

  let resizeTimer = 0;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      end();
      build();
    }, 200);
  };
  addEventListener("resize", onResize);

  return () => {
    cancelAnimationFrame(raf);
    clearTimeout(resizeTimer);
    removeEventListener("pointermove", onMove);
    removeEventListener("scroll", onLeave);
    removeEventListener("resize", onResize);
    document.documentElement.removeEventListener("mouseleave", onLeave);
    for (const photo of photos) photo.removeEventListener("load", onStonePhoto);
    sandPhoto.removeEventListener("load", onSandPhoto);
  };
}
