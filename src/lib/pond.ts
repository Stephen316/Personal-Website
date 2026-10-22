import { KOI_FLOATS_PER_FISH, makeSchool, schoolBounds, updateSchool, writeKoiMesh, type KoiPhoto } from "./koi";
import { pointer, trackPointer } from "./pointer";
import { mulberry32 } from "./sand";

// The pond is a canvas that is part of the page: absolutely positioned from
// just above the shoreline to the bottom of the document, so the browser
// scrolls it exactly like the sand and the content, with no lag. Each frame
// only a band around the screen is re-rendered (scissored; the drawing buffer
// is preserved), so the cost stays at roughly one screen of pixels.
//
// Three GL passes, cheapest first:
//   1. bake (once): a tileable four-channel noise texture. Every static or
//      slowly drifting pattern (plaster, grain, algae, colour patches) is a
//      lookup into it instead of per-pixel fbm.
//   2. caustics (per frame, half resolution): the moving light web. It's the
//      only expensive procedural term, and it's meant to look soft anyway, so
//      linear upsampling is free blur.
//   3. composite (per frame): floor, koi (a 2D canvas uploaded as a texture),
//      their shadows, and the liquid-glass surface over everything.

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

// Koi: the rigged mesh, in page px, drawn into the band-sized fish buffer
// with the baked atlas. Rows of the buffer run top-down from the band's top,
// matching how the composite samples it.
const KOI_VERT = `
attribute vec2 aPos;
attribute vec2 aUV;
uniform vec3 uBand; // page width, band top, band height
varying vec2 vUV;
void main() {
  gl_Position = vec4(aPos.x / uBand.x * 2.0 - 1.0, (aPos.y - uBand.y) / uBand.z * 2.0 - 1.0, 0.0, 1.0);
  vUV = aUV;
}`;

const KOI_FRAG = `
precision mediump float;
uniform sampler2D uAtlas;
varying vec2 vUV;
void main() { gl_FragColor = texture2D(uAtlas, vUV); }`;

// Tileable value noise: lattice coordinates wrap at the period, so the baked
// texture repeats without seams.
const BAKE = `
precision highp float;
uniform float uSize;
float hash1(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float tnoise(vec2 p, float period) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash1(mod(i, period));
  float b = hash1(mod(i + vec2(1.0, 0.0), period));
  float c = hash1(mod(i + vec2(0.0, 1.0), period));
  float d = hash1(mod(i + vec2(1.0, 1.0), period));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float tfbm(vec2 p, float period, float seed) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * tnoise(p + seed * period, period);
    p *= 2.0;
    period *= 2.0;
    a *= 0.5;
  }
  return s;
}
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  gl_FragColor = vec4(
    tfbm(uv * 4.0, 4.0, 0.0),
    tnoise(uv * 128.0, 128.0) * 0.5 + tnoise(uv * 48.0, 48.0) * 0.5,
    tfbm(uv * 3.0, 3.0, 11.0),
    tfbm(uv * 2.0, 2.0, 23.0)
  );
}`;

const CAUSTICS = `
precision highp float;
uniform vec2 uRes;
uniform float uScale;
uniform float uOrigin;   // page y of this target's top row
uniform float uTime;
uniform sampler2D uNoise;

vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}
vec2 site(vec2 cell, float t) { return 0.5 + 0.4 * sin(t + 6.2831 * hash2(cell)); }

// Distance to the nearest cell border, with junctions rounded by smin.
float border(vec2 p, float t) {
  vec2 n = floor(p);
  vec2 f = fract(p);
  vec2 mg = vec2(0.0);
  vec2 mr = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 r = g + site(n + g, t) - f;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  float res = 8.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 g = mg + vec2(float(i), float(j));
    vec2 r = g + site(n + g, t) - f;
    vec2 dr = r - mr;
    if (dot(dr, dr) > 0.00001) res = smin(res, dot(0.5 * (mr + r), normalize(dr)), 0.22);
  }
  return res;
}

void main() {
  vec2 w = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uScale + vec2(0.0, uOrigin);
  float t = uTime;
  vec2 p = w / 150.0;
  p += 0.22 * vec2(sin(p.y * 1.3 + t * 0.45), cos(p.x * 1.1 + t * 0.4));
  float a = border(p, t * 0.45);
  float b = border(p * 1.7 + 3.1, t * 0.6 + 1.7);
  // Filament strength drifts across the floor.
  float vary = 0.55 + 0.45 * texture2D(uNoise, w / 1400.0 + t * 0.004).r;
  float c = (exp(-a / 0.026) * 0.9 + exp(-a / 0.1) * 0.22) * vary + exp(-b / 0.024) * 0.35 * (1.0 - vary * 0.5);
  // Stored halved so the 8-bit target can hold values up to 2.
  gl_FragColor = vec4(c * 0.5, 0.0, 0.0, 1.0);
}`;

const COMPOSITE = `
precision highp float;
uniform vec2 uRes;
uniform float uScale;
uniform float uOrigin;   // page y of the canvas's top row
uniform float uTime;
uniform vec3 uShore;     // base y (page px), amplitude, page width
uniform vec3 uBand;      // page width, page y and height of the band buffers
uniform sampler2D uNoise;
uniform sampler2D uCaustics;
uniform sampler2D uFish;

const float PI = 3.14159265;

float shoreY(float x) {
  float u = x / uShore.z;
  return uShore.x + uShore.y * (sin(u * PI * 2.2 + 0.8) * 0.7 + sin(u * PI * 4.6 + 2.1) * 0.3);
}
float shoreSlope(float x) {
  float u = x / uShore.z;
  return uShore.y * (cos(u * PI * 2.2 + 0.8) * 0.7 * PI * 2.2 + cos(u * PI * 4.6 + 2.1) * 0.3 * PI * 4.6) / uShore.z;
}

// Slope of the glass surface, analytically: broad slow swells that act as
// moving lenses, and a lip that curls up toward the shoreline.
vec2 swellSlope(vec2 w, float t) {
  vec2 s = w / 300.0;
  float A = s.x * 1.3 + t * 0.32;
  float B = s.y * 1.1 - t * 0.27;
  float C = (s.x * 0.8 - s.y * 1.4) * 1.7 + t * 0.41;
  float D = (s.x + s.y) * 2.9 - t * 0.5;
  float cc = 0.55 * cos(C) * 1.7;
  float cd = 0.35 * cos(D) * 2.9;
  return vec2(cos(A) * 1.3 * sin(B) + cc * 0.8 + cd, sin(A) * cos(B) * 1.1 - cc * 1.4 + cd) / 300.0;
}
vec2 lipSlope(vec2 w) {
  float d = w.y - shoreY(w.x);
  if (d < 0.0) return vec2(0.0);
  float l = 2.2 * exp(-d / 34.0) / 34.0;
  return vec2(l * shoreSlope(w.x), -l);
}

// Fish and caustics live in band-sized buffers; p is a page position.
vec2 band(vec2 p) { return vec2(p.x / uBand.x, (p.y - uBand.y) / uBand.z); }
vec4 fish(vec2 p) { return texture2D(uFish, band(p)); }

void main() {
  vec2 w = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uScale + vec2(0.0, uOrigin);
  float t = uTime;

  vec2 gSwell = swellSlope(w, t);
  vec2 gLip = lipSlope(w);
  vec2 grad = gSwell + gLip;
  // The swells bend what's under them by up to ~25px; the lip, steep but
  // narrow, by less per unit slope so the edge doesn't tear.
  vec2 off = -gSwell * 2600.0 - gLip * 260.0;
  vec2 fw = w + off;
  // Fish are near the surface, so the glass bends them much less than the
  // floor beneath them.
  vec2 fcss = w + off * 0.3;

  // Floor: weathered plaster with algae, lit by turquoise ambient light and
  // the caustic filaments.
  vec4 n1 = texture2D(uNoise, fw / 512.0);
  float grain = texture2D(uNoise, fw / 96.0).g;
  vec4 n2 = texture2D(uNoise, fw / 2000.0 + vec2(t * 0.0012, -t * 0.0008));
  vec3 albedo = mix(vec3(0.86, 0.87, 0.81), vec3(0.68, 0.72, 0.66), n1.r) * (0.9 + 0.14 * grain);
  float algae = smoothstep(0.5, 0.72, n2.b) * (0.65 + 0.35 * n1.g);
  albedo = mix(albedo, vec3(0.36, 0.5, 0.28), algae * 0.75);
  vec3 water = mix(vec3(0.04, 0.66, 0.7), vec3(0.14, 0.9, 0.86), smoothstep(0.42, 0.72, n2.a));
  float light = texture2D(uCaustics, band(fw)).r * 2.0;
  vec3 floorCol = albedo * (water * 1.3 + vec3(0.8, 1.0, 0.95) * light * 1.4);

  // Koi shadows: the fish layer's alpha, offset and blurred on the GPU.
  vec2 so = fcss - vec2(22.0, 32.0);
  float sh = fish(so).a * 0.2;
  sh += (fish(so + vec2(7.0, 0.0)).a + fish(so - vec2(7.0, 0.0)).a) * 0.1;
  sh += (fish(so + vec2(0.0, 7.0)).a + fish(so - vec2(0.0, 7.0)).a) * 0.1;
  sh += (fish(so + vec2(5.0, 5.0)).a + fish(so - vec2(5.0, 5.0)).a) * 0.1;
  sh += (fish(so + vec2(5.0, -5.0)).a + fish(so - vec2(5.0, -5.0)).a) * 0.1;
  floorCol *= 1.0 - sh * 0.45;

  // Koi, seen through the same glass: refracted, colour-fringed, softened,
  // cooled by the water and dappled by the caustics.
  vec2 ca = off * 0.012 + vec2(0.3, 0.0);
  vec4 fg = (fish(fcss) * 2.0 + fish(fcss + vec2(1.0, 0.0)) + fish(fcss - vec2(1.0, 0.0)) + fish(fcss + vec2(0.0, 1.0)) + fish(fcss - vec2(0.0, 1.0))) / 6.0;
  vec3 f = vec3(fish(fcss + ca).r, fg.g, fish(fcss - ca).b);
  f *= vec3(0.84, 0.97, 0.96) * (0.82 + 0.4 * min(light, 1.4));
  f = mix(f, floorCol * fg.a, 0.14);
  vec3 col = floorCol * (1.0 - fg.a) + f;

  // Filmic response: highlights roll off instead of clipping flat.
  col = vec3(1.0) - exp(-col * 1.3);

  // The glass itself: glints, a fresnel sheen, and a bright rim at the shore.
  vec3 n = normalize(vec3(-grad * 26.0, 1.0));
  vec3 hlf = normalize(normalize(vec3(-0.45, 0.6, 0.66)) + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(n, hlf), 0.0), 70.0);
  float fresnel = pow(1.0 - n.z, 2.0);
  col += vec3(1.0) * spec * 0.6 + vec3(0.85, 1.0, 0.98) * fresnel * 0.45;
  float depth = w.y - shoreY(w.x);
  col += vec3(1.0) * exp(-max(depth, 0.0) / 3.5) * 0.4;
  gl_FragColor = vec4(col, 1.0);
}`;

// The shoreline in page coordinates: base y, wave amplitude, and y at x.
export type Shore = { base: () => number; amp: () => number; at: (x: number) => number };

const NOISE_SIZE = 512;
const CAUSTIC_SCALE = 0.5;
const MARGIN = 0.35; // extra band above and below the screen, in viewport heights
const MAX_CANVAS = 8192;

export function startPond(canvas: HTMLCanvasElement, shore: Shore, reduced: boolean) {
  trackPointer();
  const gl = canvas.getContext("webgl", {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance",
  });
  const bake = gl && program(gl, BAKE);
  const caustics = gl && program(gl, CAUSTICS);
  const composite = gl && program(gl, COMPOSITE);
  if (!gl || !bake || !caustics || !composite) {
    // Without WebGL the CSS gradient on the canvas element stands in for water.
    return () => {};
  }

  const koi = program(gl, KOI_FRAG, KOI_VERT);
  if (!koi) return () => {};
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const bindProgram = (p: WebGLProgram) => {
    gl.useProgram(p);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    const loc = gl.getAttribLocation(p, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  };
  const uni = (p: WebGLProgram) => (name: string) => gl.getUniformLocation(p, name);

  const texture = (wrap: number) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    return t;
  };
  const renderTarget = (tex: WebGLTexture | null, w: number, h: number) => {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return fb;
  };

  // 1. Bake the noise once. Power-of-two size, so it can repeat.
  const noiseTex = texture(gl.REPEAT);
  const noiseFb = renderTarget(noiseTex, NOISE_SIZE, NOISE_SIZE);
  bindProgram(bake);
  gl.viewport(0, 0, NOISE_SIZE, NOISE_SIZE);
  gl.uniform1f(uni(bake)("uSize"), NOISE_SIZE);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(noiseFb);

  const causticTex = texture(gl.CLAMP_TO_EDGE);
  let causticFb: WebGLFramebuffer | null = null;
  const fishTex = texture(gl.CLAMP_TO_EDGE);
  let fishFb: WebGLFramebuffer | null = null;
  const atlasTex = texture(gl.CLAMP_TO_EDGE);
  const koiBuf = gl.createBuffer();
  let koiVerts = new Float32Array(0);

  let school = makeSchool(0, 1, 0, 1, 1, mulberry32(1));
  let seeded = false;

  // The koi photos: one atlas image plus where each fish sits in it. Fish
  // appear once both have loaded.
  let photos: KoiPhoto[] = [];
  let atlasReady = false;
  void (async () => {
    try {
      const res = await fetch("/koi/atlas.json");
      const meta: { width: number; height: number; rows: { y: number; h: number }[] } = await res.json();
      const img = new Image();
      img.src = "/koi/atlas.webp";
      await img.decode();
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, atlasTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      photos = meta.rows.map((r) => ({
        v0: r.y / meta.height,
        v1: (r.y + r.h) / meta.height,
        aspect: r.h / meta.width,
      }));
      atlasReady = true;
      seeded = false;
    } catch {
      // Without the photos the pond simply has no fish.
    }
  })();
  const ku = uni(koi);
  const kuBand = ku("uBand");
  const kaPos = gl.getAttribLocation(koi, "aPos");
  const kaUV = gl.getAttribLocation(koi, "aUV");

  const cu = uni(caustics);
  const cuRes = cu("uRes");
  const cuScale = cu("uScale");
  const cuOrigin = cu("uOrigin");
  const cuTime = cu("uTime");
  const mu = uni(composite);
  const muRes = mu("uRes");
  const muScale = mu("uScale");
  const muOrigin = mu("uOrigin");
  const muTime = mu("uTime");
  const muShore = mu("uShore");
  const muBand = mu("uBand");
  bindProgram(caustics);
  gl.uniform1i(cu("uNoise"), 0);
  bindProgram(composite);
  gl.uniform1i(mu("uNoise"), 0);
  gl.uniform1i(mu("uCaustics"), 1);
  gl.uniform1i(mu("uFish"), 2);
  gl.useProgram(koi);
  gl.uniform1i(ku("uAtlas"), 3);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

  let vw = 0;
  let vh = 0;
  let top0 = 0; // page y of the canvas's top edge
  let pondH = 1;
  let scale = 1;
  let quality = 1; // steps down if frames run long
  let bandH = 1; // band buffers' height, page px
  let cw = 1;
  let ch = 1;

  const layout = () => {
    vw = innerWidth;
    vh = innerHeight;
    top0 = Math.floor(shore.base() - shore.amp() * 1.3);
    // Measure the page without this canvas, which would otherwise hold the
    // document at its old height.
    canvas.style.height = "0px";
    pondH = Math.max(1, document.documentElement.scrollHeight - top0);
    canvas.style.top = `${top0}px`;
    canvas.style.height = `${pondH}px`;
    // Rendered a little under full resolution: the browser's smooth upscale is
    // the slight softness wanted over the whole pond, and it's cheaper.
    scale = Math.min(devicePixelRatio, 1.5) * 0.75 * quality;
    while (pondH * scale > MAX_CANVAS || vw * scale > MAX_CANVAS) scale *= 0.9;
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(pondH * scale);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0.04, 0.4, 0.42, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    bandH = Math.min(pondH, Math.round(vh * (1 + 2 * MARGIN)));
    if (fishFb) gl.deleteFramebuffer(fishFb);
    fishFb = renderTarget(fishTex, vw, bandH);
    cw = Math.max(1, Math.round(vw * CAUSTIC_SCALE * quality));
    ch = Math.max(1, Math.round(bandH * CAUSTIC_SCALE * quality));
    if (causticFb) gl.deleteFramebuffer(causticFb);
    causticFb = renderTarget(causticTex, cw, ch);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };

  let relayout = 0;
  const onResize = () => {
    clearTimeout(relayout);
    relayout = window.setTimeout(() => {
      layout();
      seeded = false;
    }, 120);
  };
  layout();
  addEventListener("resize", onResize);
  // Content height changes (fonts, cards) move the bottom of the page.
  const ro = new ResizeObserver(onResize);
  ro.observe(document.body);

  let raf = 0;
  let last = performance.now();
  let lastPointer: { x: number; y: number } | null = null;
  let cursorSpeed = 0;
  let slow = 0;
  let fishShown = true;
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const top = scrollY;

    // The band this frame: the screen plus a margin, clipped to the pond.
    const bandTop = Math.max(top0, Math.min(top0 + pondH - bandH, top - vh * MARGIN));
    const visTop = Math.max(top0, top);
    const visBottom = Math.min(top0 + pondH, top + vh);
    if (visBottom <= visTop) return;

    // Dynamic resolution: a sustained run of long frames steps the scale down.
    if (dt > 0.022) slow++;
    else slow = Math.max(0, slow - 1);
    if (slow > 40 && quality > 0.6) {
      quality = Math.max(0.6, quality * 0.85);
      slow = 0;
      layout();
    }

    const t = reduced ? 12 : now / 1000;
    if (!seeded) {
      const s0 = shore.base() + shore.amp() * 2;
      const size = Math.min(1.3, Math.max(0.65, Math.min(vw, vh) / 850));
      school = makeSchool(photos.length, vw, s0 + 80, Math.min(top0 + pondH - 80, s0 + vh * 0.8), size, mulberry32(42));
      koiVerts = new Float32Array(KOI_FLOATS_PER_FISH * Math.max(1, school.length));
      gl.bindBuffer(gl.ARRAY_BUFFER, koiBuf);
      gl.bufferData(gl.ARRAY_BUFFER, koiVerts.byteLength, gl.DYNAMIC_DRAW);
      seeded = true;
    }
    if (!reduced) {
      // Cursor speed from screen movement (scrolling isn't the cursor moving),
      // averaged over about 70ms so one jumpy frame can't read as a flick.
      if (pointer.active && lastPointer && dt > 0) {
        const moved = Math.hypot(pointer.x - lastPointer.x, pointer.y - lastPointer.y);
        cursorSpeed += (moved / dt - cursorSpeed) * (1 - Math.exp(-dt * 14));
      } else cursorSpeed = 0;
      lastPointer = pointer.active ? { x: pointer.x, y: pointer.y } : null;
      const aim = pointer.active ? { x: pointer.x, y: pointer.y + top, speed: cursorSpeed } : null;
      const y0 = Math.max(top, shore.base() - shore.amp());
      const water = { w: vw, top: shore.at, bottom: top0 + pondH, view: { y0, y1: Math.max(y0 + 1, top + vh) } };
      updateSchool(school, aim, water, t, dt);
    }

    // Fish layer: the rigged koi meshes, re-rendered only while a fish is in
    // the band (and once more to clear it after the last one leaves).
    gl.disable(gl.SCISSOR_TEST);
    const b = schoolBounds(school);
    const visible = atlasReady && school.length > 0 && b.y1 > bandTop && b.y0 < bandTop + bandH;
    if (visible || fishShown) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fishFb);
      gl.viewport(0, 0, vw, bandH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (visible) {
        const count = writeKoiMesh(school, photos, koiVerts);
        gl.useProgram(koi);
        gl.bindBuffer(gl.ARRAY_BUFFER, koiBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, koiVerts.subarray(0, count * 4));
        gl.enableVertexAttribArray(kaPos);
        gl.vertexAttribPointer(kaPos, 2, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(kaUV);
        gl.vertexAttribPointer(kaUV, 2, gl.FLOAT, false, 16, 8);
        gl.uniform3f(kuBand, vw, bandTop, bandH);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, atlasTex);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.TRIANGLES, 0, count);
        gl.disable(gl.BLEND);
        gl.disableVertexAttribArray(kaUV);
      }
      fishShown = visible;
    }
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, fishTex);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, noiseTex);

    // 2. Caustics for the band, at reduced resolution.
    gl.disable(gl.SCISSOR_TEST);
    bindProgram(caustics);
    gl.bindFramebuffer(gl.FRAMEBUFFER, causticFb);
    gl.viewport(0, 0, cw, ch);
    gl.uniform2f(cuRes, cw, ch);
    gl.uniform1f(cuScale, cw / vw);
    gl.uniform1f(cuOrigin, bandTop);
    gl.uniform1f(cuTime, t);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 3. Composite into the page canvas, touching only the band's rows.
    bindProgram(composite);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, causticTex);
    gl.viewport(0, 0, canvas.width, canvas.height);
    const rowTop = Math.max(0, Math.floor((bandTop - top0) * scale));
    const rowBottom = Math.min(canvas.height, Math.ceil((bandTop + bandH - top0) * scale));
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, canvas.height - rowBottom, canvas.width, rowBottom - rowTop);
    gl.uniform2f(muRes, canvas.width, canvas.height);
    gl.uniform1f(muScale, scale);
    gl.uniform1f(muOrigin, top0);
    gl.uniform1f(muTime, t);
    gl.uniform3f(muShore, shore.base(), shore.amp(), vw);
    gl.uniform3f(muBand, vw, bandTop, bandH);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    clearTimeout(relayout);
    ro.disconnect();
    removeEventListener("resize", onResize);
  };
}

function program(gl: WebGLRenderingContext, fs: string, vs = VERT) {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const v = compile(gl.VERTEX_SHADER, vs);
  const f = compile(gl.FRAGMENT_SHADER, fs);
  const p = gl.createProgram();
  if (!v || !f || !p) return null;
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  return gl.getProgramParameter(p, gl.LINK_STATUS) ? p : null;
}
