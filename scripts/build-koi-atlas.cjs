// Builds public/koi/atlas.webp and atlas.json from the sprite-parts sheets in
// design/koi-source (one PNG per variety: body on top; tail, two pectoral
// and two pelvic fins below). Run: node scripts/build-koi-atlas.cjs
//
// Each sheet is split into its parts by connected regions of solid alpha.
// Per fish the atlas gets a row of body, tail fin, one pectoral and one
// pelvic fin (the rig mirrors fins for the far side), all at one scale so
// their sizes stay true to each other. The atlas is 1024x1024 so WebGL 1 can
// mipmap it; parts are padded apart so mip levels don't bleed together.
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const src = path.join(root, "design/koi-source");
const outDir = path.join(root, "public/koi");
const names = ["kohaku", "sanke", "showa", "tancho", "asagi", "goshiki", "ogon"];
const K = 0.38; // sheet px to atlas px
const PAD = 8;
const SIZE = 1024;
// The body ends in a darker cut cap and the tail fin starts with one; both
// are trimmed (sheet px), and the body's cut edge is feathered.
const BODY_CAP = 10;
const BODY_FEATHER = 6;
const TAIL_CAP = 8;

// Parts as bounding boxes: the body (largest) and the rest left to right
// (tail, pectoral, pectoral, pelvic, pelvic).
function segment(data, W, H) {
  const lab = new Int32Array(W * H).fill(-1);
  const q = new Int32Array(W * H);
  const comps = [];
  for (let s = 0; s < W * H; s++) {
    if (lab[s] !== -1 || data[s * 4 + 3] < 64) continue;
    let h = 0;
    let t = 0;
    q[t++] = s;
    lab[s] = comps.length;
    const c = { x0: W, y0: H, x1: 0, y1: 0, area: 0 };
    while (h < t) {
      const p = q[h++];
      const x = p % W;
      const y = (p / W) | 0;
      c.area++;
      c.x0 = Math.min(c.x0, x);
      c.x1 = Math.max(c.x1, x);
      c.y0 = Math.min(c.y0, y);
      c.y1 = Math.max(c.y1, y);
      const nbs = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, p - W, p + W];
      for (const nb of nbs) {
        if (nb < 0 || nb >= W * H || lab[nb] !== -1 || data[nb * 4 + 3] < 64) continue;
        lab[nb] = comps.length;
        q[t++] = nb;
      }
    }
    comps.push(c);
  }
  const big = comps.filter((c) => c.area > 2000).sort((a, b) => b.area - a.area);
  if (big.length !== 6) throw new Error(`expected 6 parts, found ${big.length}`);
  return { body: big[0], rest: big.slice(1).sort((a, b) => a.x0 - b.x0) };
}

// The generator leaves a faint haze round every part and tops out just
// under 255; clear the haze and stretch what's left to fully solid.
function cleanAlpha(data) {
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i];
    data[i] = a < 16 ? 0 : Math.min(255, Math.round(((a - 16) * 255) / (248 - 16)));
  }
}

async function part(img, info, box, trimL, trimR, featherR) {
  const x = box.x0 + trimL;
  const w = box.x1 - box.x0 + 1 - trimL - trimR;
  const h = box.y1 - box.y0 + 1;
  const buf = await sharp(img, { raw: info }).extract({ left: x, top: box.y0, width: w, height: h }).raw().toBuffer();
  for (let yy = 0; yy < h; yy++) {
    for (let k = 0; k < featherR; k++) {
      const i = (yy * w + (w - 1 - k)) * 4 + 3;
      buf[i] = Math.round(buf[i] * ((k + 0.5) / featherR));
    }
  }
  const sw = Math.round(w * K);
  const sh = Math.round(h * K);
  const png = await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).resize(sw, sh, { kernel: "lanczos3" }).png().toBuffer();
  return { png, w: sw, h: sh };
}

(async () => {
  const layers = [];
  const meta = { width: SIZE, height: SIZE, fish: [] };
  let y = PAD;
  for (const n of names) {
    const { data, info } = await sharp(path.join(src, `${n}.png`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    cleanAlpha(data);
    const s = segment(data, info.width, info.height);
    const parts = {
      body: await part(data, info, s.body, 0, BODY_CAP, BODY_FEATHER),
      tail: await part(data, info, s.rest[0], TAIL_CAP, 0, 0),
      pec: await part(data, info, s.rest[1], 0, 0, 0),
      pelvic: await part(data, info, s.rest[3], 0, 0, 0),
    };
    let x = PAD;
    let rowH = 0;
    const rects = { name: n };
    for (const [k, p] of Object.entries(parts)) {
      layers.push({ input: p.png, left: x, top: y });
      rects[k] = [x, y, p.w, p.h];
      x += p.w + PAD;
      rowH = Math.max(rowH, p.h);
    }
    if (x > SIZE) throw new Error(`${n}: row is ${x}px wide`);
    meta.fish.push(rects);
    y += rowH + PAD;
  }
  if (y > SIZE) throw new Error(`atlas is ${y}px tall`);
  const res = await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(layers)
    .webp({ quality: 90, alphaQuality: 100, effort: 6 })
    .toFile(path.join(outDir, "atlas.webp"));
  fs.writeFileSync(path.join(outDir, "atlas.json"), JSON.stringify(meta, null, 1) + "\n");
  console.log(`atlas ${SIZE}x${SIZE}, ${Math.round(res.size / 1024)}KB, ${meta.fish.length} fish`);
})();
