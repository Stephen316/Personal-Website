import { KOI_FLOATS_PER_FISH, makeSchool, schoolBounds, updateSchool, writeKoiMesh, type KoiKind } from "./koi";
import { pointer, trackPointer } from "./pointer";
import { mulberry32 } from "./sand";

// The pond is a canvas that is part of the page: absolutely positioned from
// just above the shoreline to the bottom of the document, so the browser
// scrolls it exactly like the sand and the content, with no lag. Each frame
// only a band around the screen is re-rendered (scissored; the drawing buffer
// is preserved), so the cost stays at roughly one screen of pixels.
//
// GL passes, cheapest first:
//   1. bake (once): a tileable four-channel noise texture. Every static or
//      slowly drifting pattern (plaster, grain, algae, colour patches) is a
//      lookup into it instead of per-pixel fbm.
//   2. ripples (per frame, if float textures render): Evan Wallace's height-
//      field wave sim from WebGL Water, over the band, fed by the cursor and
//      the koi. It scrolls with the band; rows entering it start flat.
//   3. caustics (per frame): Evan Wallace's method, with the eye straight
//      down and the sun nearly so. A grid over the band is pushed by the same
//      refraction offset the composite uses to look at the floor, and drawn
//      additively at 1/|det J|: light bunched up is brighter, light spread
//      out dimmer, folds add. With vertical rays the floor is the target's
//      own plane, so there's no light-space projection, wall test or
//      derivative extension. Without vertex textures the old procedural web
//      stands in.
//   4. composite (per frame): floor, koi (a 2D canvas uploaded as a texture),
//      their shadows, and the liquid-glass surface over everything.
//   5. bloom (per frame): the design's Bloom effect on the pond, glow added
//      back over the composited band.

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

const WAVE_COUNT = 12;

// The water surface, shared by the caustics (light going down) and the
// composite (the eye looking down). Both bend by floorOffset: the eye sees the
// floor, and the light on it, through the same moving water that focused it.
// The sun isn't overhead, though: SUN is how far a koi's shadow falls from
// it, and light reaching a floor point entered the water that much further
// back (scaled to the floor's depth). With the sun behind the eye instead,
// every focus would be magnified straight back at the viewer: blobs, not a web.
const SURFACE = `
const vec2 SUN = vec2(22.0, 32.0);
const float KOI_HEIGHT = 0.7; // koi swim this far up from floor to surface
uniform float uTime;
uniform sampler2D uNoise;
uniform vec4 uWaveK[${WAVE_COUNT}];  // wave vector (rad/px), angular speed, phase
uniform float uWaveA[${WAVE_COUNT}]; // offset amplitude over wavenumber
uniform vec3 uShore;     // base y (page px), amplitude, page width
uniform sampler2D uSim;  // ripple slopes: the step before the latest in .rg, the latest in .ba
uniform vec4 uSimRect;   // page x, y, width, height the ripple sim covers
uniform float uSimGain;  // sim height steps to surface slope; 0 with no sim
uniform float uSimAlpha; // how far this frame is between those two steps

const float PI = 3.14159265;
const float LENS = 2600.0; // floor offset per unit of surface slope, px

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
// Ripples from the sim. It runs at a fixed rate, so a frame lands between two
// of its steps; blending them keeps the motion even whatever the frame rate.
vec2 simSlope(vec2 w) {
  vec2 uv = (w - uSimRect.xy) / uSimRect.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec2(0.0);
  vec4 s = texture2D(uSim, uv);
  return mix(s.rg, s.ba, uSimAlpha) * uSimGain;
}
// The wind ripples that make the light web, as a floor offset. Their focusing
// strength drifts across the pond.
vec2 waveOffset(vec2 p, float t) {
  vec2 o = vec2(0.0);
  for (int i = 0; i < ${WAVE_COUNT}; i++) {
    vec4 k = uWaveK[i];
    o -= k.xy * uWaveA[i] * cos(dot(k.xy, p) - k.z * t + k.w);
  }
  return o * (0.55 + 0.45 * texture2D(uNoise, p / 1400.0 + t * 0.004).r);
}
// The swells bend what's under them by up to ~25px; the lip, steep but
// narrow, by less per unit slope so the edge doesn't tear.
vec2 floorOffset(vec2 p) {
  return -(swellSlope(p, uTime) + simSlope(p)) * LENS - lipSlope(p) * 260.0 + waveOffset(p, uTime);
}`;

const CAUSTIC_VERT = `
attribute vec2 aGrid;
uniform vec3 uGrid;      // page x, y of the first vertex, spacing
uniform vec3 uBand;      // page width, band top, band height
varying float vDet;
${SURFACE}

void main() {
  vec2 p = uGrid.xy + aGrid * uGrid.z;
  float e = uGrid.z * 0.5;
  vec2 ox0 = floorOffset(p - vec2(e, 0.0));
  vec2 ox1 = floorOffset(p + vec2(e, 0.0));
  vec2 oy0 = floorOffset(p - vec2(0.0, e));
  vec2 oy1 = floorOffset(p + vec2(0.0, e));
  // Jacobian of p -> p + offset, by central differences one cell wide.
  vec2 jx = vec2(1.0, 0.0) + (ox1 - ox0) / uGrid.z;
  vec2 jy = vec2(0.0, 1.0) + (oy1 - oy0) / uGrid.z;
  vDet = jx.x * jy.y - jx.y * jy.x;
  vec2 q = p + SUN / KOI_HEIGHT + (ox0 + ox1 + oy0 + oy1) * 0.25;
  gl_Position = vec4(q.x / uBand.x * 2.0 - 1.0, (q.y - uBand.y) / uBand.z * 2.0 - 1.0, 0.0, 1.0);
}`;

// Interpolating the determinant, not its reciprocal, puts the focus line
// inside the triangle where it crosses zero, so filaments stay sharp at any
// grid spacing. The sun is a disc, not a point, so a focus is a soft peak of
// ~6x open-water light a few px wide rather than a spike: thin enough to read
// as a line, wide enough to stay white through the pond's blur. Stored
// linear: uStore is 1 in a half-float target, 1/16 in an 8-bit one.
const CAUSTIC_FRAG = `
precision mediump float;
uniform float uStore;
varying float vDet;
void main() { gl_FragColor = vec4(uStore * inversesqrt(vDet * vDet + 0.03), 0.0, 0.0, 1.0); }`;

// The ripple sim, one step. State is (height, velocity) per texel; rows run
// down the page like the band buffers. uShift scrolls the
// field when the band moves, and uDrops adds cosine bumps (texel x, y,
// radius, height).
const SIM_STEP = `
precision highp float;
uniform sampler2D uState;
uniform vec2 uSize;
uniform float uShift;
uniform vec4 uDrops[16];
const float PI = 3.14159265;
void main() {
  vec2 c = gl_FragCoord.xy;
  vec2 src = c + vec2(0.0, uShift);
  if (src.y < 0.0 || src.y > uSize.y) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec2 uv = src / uSize;
  vec2 dx = vec2(1.0 / uSize.x, 0.0);
  vec2 dy = vec2(0.0, 1.0 / uSize.y);
  vec4 s = texture2D(uState, uv);
  float avg = (texture2D(uState, uv - dx).r + texture2D(uState, uv + dx).r + texture2D(uState, uv - dy).r + texture2D(uState, uv + dy).r) * 0.25;
  // Waves cross ~0.35 texel a step, half Evan's speed: at his, a ripple moved
  // a third of its own length per frame and its thin caustic lines strobed.
  s.g = (s.g + (avg - s.r) * 0.5) * 0.995;
  // A slow leak back to level, so drops can't raise the whole pond, and a
  // little viscosity: the finest ripples die first, as on real water, and
  // texel-sized ones would only alias in the caustic grid.
  s.r = mix(s.r + s.g, avg, 0.1) * 0.999;
  for (int i = 0; i < 16; i++) {
    vec4 d = uDrops[i];
    float k = max(0.0, 1.0 - length(c - d.xy) / max(d.z, 0.001));
    s.r += (0.5 - 0.5 * cos(k * PI)) * d.w;
  }
  gl_FragColor = s;
}`;

// Slopes (central height differences) of the last two sim steps, for the
// consumers to blend. If that last step also scrolled the field, the step
// before it is still in the old rows: uPrevShift lines it up.
const SIM_SLOPE = `
precision highp float;
uniform sampler2D uPrev;
uniform sampler2D uCur;
uniform vec2 uSize;
uniform float uPrevShift;
vec2 slope(sampler2D s, vec2 c) {
  if (c.y < 0.0 || c.y > uSize.y) return vec2(0.0);
  vec2 uv = c / uSize;
  vec2 dx = vec2(1.0 / uSize.x, 0.0);
  vec2 dy = vec2(0.0, 1.0 / uSize.y);
  return vec2(texture2D(s, uv + dx).r - texture2D(s, uv - dx).r, texture2D(s, uv + dy).r - texture2D(s, uv - dy).r) * 0.5;
}
void main() {
  gl_FragColor = vec4(slope(uPrev, gl_FragCoord.xy + vec2(0.0, uPrevShift)), slope(uCur, gl_FragCoord.xy));
}`;

// The procedural web, for GPUs without vertex textures.
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
  // Row 0 of this target is the band's top, as the composite samples it.
  vec2 w = gl_FragCoord.xy / uScale + vec2(0.0, uOrigin);
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
uniform vec3 uBand;      // page width, page y and height of the band buffers
uniform vec4 uLight;     // caustic texel to light, ambient, sun, mean light
uniform sampler2D uCaustics;
${SURFACE}

// The caustics live in a band-sized buffer; p is a page position.
vec2 band(vec2 p) { return vec2(p.x / uBand.x, (p.y - uBand.y) / uBand.z); }

// The pond layer alone, as in the design: floor, light and the glass. The
// koi are a layer of their own over it, after the bloom and the blur.
void main() {
  vec2 w = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uScale + vec2(0.0, uOrigin);
  float t = uTime;

  // floorOffset(w), split up so the glints can use the slopes too.
  vec2 gSwell = swellSlope(w, t) + simSlope(w);
  vec2 gLip = lipSlope(w);
  vec2 wave = waveOffset(w, t);
  vec2 grad = gSwell + gLip - wave / LENS;
  vec2 fw = w - gSwell * LENS - gLip * 260.0 + wave;

  // Floor: weathered plaster with algae, lit by turquoise ambient light and
  // the caustic filaments.
  vec4 n1 = texture2D(uNoise, fw / 512.0);
  float grain = texture2D(uNoise, fw / 96.0).g;
  vec4 n2 = texture2D(uNoise, fw / 2000.0 + vec2(t * 0.0012, -t * 0.0008));
  vec3 albedo = mix(vec3(0.82, 0.88, 0.88), vec3(0.64, 0.72, 0.72), n1.r) * (0.9 + 0.14 * grain);
  float algae = smoothstep(0.5, 0.72, n2.b) * (0.65 + 0.35 * n1.g);
  albedo = mix(albedo, vec3(0.36, 0.5, 0.28), algae * 0.75);
  vec3 water = mix(vec3(0.02, 0.66, 0.78), vec3(0.07, 0.9, 0.98), smoothstep(0.42, 0.72, n2.a));
  float light = texture2D(uCaustics, band(fw)).r * uLight.x;
  vec3 col = albedo * (water * uLight.y + vec3(0.68, 1.0, 1.05) * light * uLight.z);

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

// Bloom, as the design's "Bloom" effect on the pond sets it: anything brighter
// than luminance ~0.11 (nearly all of it) inside a spotlight round the pond's
// middle is blurred at two widths and 30% of that is added back. The
// composite renders into a scene texture covering the band's canvas rows; row
// 0 of it is the band's bottom row.
//
// Extract: the bright, spotlit scene at quarter page resolution. Four
// bilinear taps, so caustic lines a texel wide don't sparkle on the way down.
const BLOOM_EXTRACT = `
precision mediump float;
uniform sampler2D uScene;
uniform vec2 uSize;      // this target, texels
uniform vec4 uMap;       // scene width, height (texels), band's bottom canvas row, canvas px per page px
uniform vec2 uPond;      // pond (canvas) height and width, page px
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec2 t = 1.0 / uMap.xy;
  vec3 c = (texture2D(uScene, uv + t * vec2(-1.0, -1.0)).rgb + texture2D(uScene, uv + t * vec2(1.0, -1.0)).rgb
    + texture2D(uScene, uv + t * vec2(-1.0, 1.0)).rgb + texture2D(uScene, uv + t * vec2(1.0, 1.0)).rgb) * 0.25;
  float bright = smoothstep(0.1075, 0.1575, dot(c, vec3(0.2126, 0.7152, 0.0722)));
  // The spotlight is a circle in the pond's box, centred at (50%, 58%) with
  // a radius of 70% of its height, feathered over its last tenth. p is in
  // page px from the pond's top left.
  vec2 p = vec2(uv.x * uMap.x, uMap.z - uv.y * uMap.y) / uMap.w;
  vec2 q = vec2((p.x / uPond.y - 0.5) * uPond.y / uPond.x, p.y / uPond.x - 0.5814);
  float spot = 1.0 - smoothstep(0.7012 * 0.9, 0.7012, length(q));
  gl_FragColor = vec4(c * bright * spot, 1.0);
}`;

// One direction of a Gaussian, sigma uSigma taps of uStep (up to 12 taps
// each way). Blurs the glow, halves it, and blurs the pond across.
const BLOOM_BLUR = `
precision mediump float;
uniform sampler2D uSrc;
uniform vec2 uSize;      // this target, texels
uniform vec2 uStep;      // one tap, in the source's uv
uniform float uSigma;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec3 s = vec3(0.0);
  float n = 0.0;
  for (int i = -12; i <= 12; i++) {
    float f = float(i);
    float k = exp(-f * f / (2.0 * uSigma * uSigma));
    s += texture2D(uSrc, uv + uStep * f).rgb * k;
    n += k;
  }
  gl_FragColor = vec4(s / n, 1.0);
}`;

// The pond onto the page canvas, texel for texel: the design's "Pond blur"
// down (the scene comes in already blurred across), with the glow added
// first, as Pond (with its Bloom) sits under Pond blur there.
const BLOOM_FINAL = `
precision mediump float;
uniform sampler2D uScene;
uniform sampler2D uNear;   // glow blurred ~24 page px
uniform sampler2D uFar;    // and ~48
uniform vec3 uMap;         // scene width, height (texels), canvas rows below the band
uniform float uSigma;      // the pond blur, in scene texels
void main() {
  vec2 uv = (gl_FragCoord.xy - vec2(0.0, uMap.z)) / uMap.xy;
  vec3 s = vec3(0.0);
  float n = 0.0;
  for (int i = -12; i <= 12; i++) {
    float f = float(i);
    float k = exp(-f * f / (2.0 * uSigma * uSigma));
    s += texture2D(uScene, uv + vec2(0.0, f / uMap.y)).rgb * k;
    n += k;
  }
  vec3 glow = texture2D(uNear, uv).rgb * 0.6 + texture2D(uFar, uv).rgb * 0.4;
  gl_FragColor = vec4(min(s / n + glow * 0.3, 1.0), 1.0);
}`;

// The koi layer, over the finished pond as in the design: sharp, unbloomed.
// Each koi and its shadow are drawn premultiplied, blended over what's there,
// so the shadow darkens the pond and the fish covers it. They still look
// underwater: refracted by the same surface, colour-fringed, cooled, and
// dappled by a weak copy of the floor's light.
const KOI_LAYER = `
precision highp float;
uniform vec2 uRes;
uniform float uScale;
uniform float uOrigin;   // page y of the canvas's top row
uniform vec3 uBand;      // page width, page y and height of the band buffers
uniform vec4 uLight;     // caustic texel to light, ambient, sun, mean light
uniform sampler2D uCaustics;
uniform sampler2D uFish;
${SURFACE}

vec2 band(vec2 p) { return vec2(p.x / uBand.x, (p.y - uBand.y) / uBand.z); }
vec4 fish(vec2 p) { return texture2D(uFish, band(p)); }

void main() {
  vec2 w = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uScale + vec2(0.0, uOrigin);
  // Most of the pond has no fish near it: skip the surface maths there.
  float near = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 d = vec2(float(i), float(j)) * 14.0;
    near += fish(w + d).a + fish(w - SUN + d).a;
  }
  if (near < 0.002) discard;

  vec2 gSwell = swellSlope(w, uTime) + simSlope(w);
  vec2 off = -gSwell * LENS - lipSlope(w) * 260.0 + waveOffset(w, uTime);
  // Fish are near the surface, so the glass bends them much less than the
  // floor beneath them.
  vec2 fcss = w + off * 0.3;

  // Shadow: the fish layer's alpha, offset towards the sun's fall and
  // blurred. Nothing blurs it afterwards any more, so it takes two rings of
  // eight taps (Gaussian weights) to come out a soft blob, not offset copies.
  vec2 so = fcss - SUN;
  float sh = fish(so).a * 0.16;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7854 + 0.39;
    vec2 d = vec2(cos(a), sin(a));
    sh += fish(so + d * 6.0).a * 0.065 + fish(so + d * 12.0).a * 0.04;
  }
  float shade = sh * 0.45;

  vec2 ca = off * 0.012 + vec2(0.3, 0.0);
  vec4 fg = (fish(fcss) * 2.0 + fish(fcss + vec2(1.0, 0.0)) + fish(fcss - vec2(1.0, 0.0)) + fish(fcss + vec2(0.0, 1.0)) + fish(fcss - vec2(0.0, 1.0))) / 6.0;
  vec3 f = vec3(fish(fcss + ca).r, fg.g, fish(fcss - ca).b);
  float light = texture2D(uCaustics, band(w + off)).r * uLight.x;
  // Near the surface the light hasn't focused yet: the koi see a weak copy
  // of the floor's web.
  f *= vec3(0.84, 0.97, 0.96) * (0.66 + 0.3 * mix(1.0, min(light, 4.0) / uLight.w, 0.35));
  // A little of the water's colour over them, and the pond's filmic response
  // (on the straight colour, then premultiplied again).
  f = mix(f, vec3(0.3, 0.75, 0.74) * fg.a, 0.14);
  f = (vec3(1.0) - exp(-f / max(fg.a, 0.001) * 1.3)) * fg.a;
  gl_FragColor = vec4(f, shade + fg.a - shade * fg.a);
}`;

// The shoreline in page coordinates: base y, wave amplitude, and y at x.
export type Shore = { base: () => number; amp: () => number; at: (x: number) => number };

const NOISE_SIZE = 512;
// The mesh pass costs per vertex, not per pixel, so the light renders at full
// page resolution: thin filaments stay thin.
const CAUSTIC_SCALE = 1;
const CAUSTIC_GRID = 6; // page px between caustic mesh vertices, at full quality
const CAUSTIC_PAD = 80; // mesh overhang past the band: light can land from outside it
// Floor light is linear: ambient sky through the water, plus sunlight that
// averages 1 and is only moved around by the ripples, never added or thrown
// away. Tuned, with the bloom, to the design's water: mean colour and
// luminance percentiles measured in the same patch of both at 1440 x 900.
const AMBIENT = 1.12;
const SUN = 0.7;
// The design's "Pond blur" over the pond, under the koi: a 3 px Gaussian
// (CSS blur(3px)), in page px.
const POND_BLUR = 3;
const SIM_PX = 5; // page px per ripple texel
const SIM_HZ = 120; // fixed sim steps per second, so ripples don't speed up at 144Hz
const SIM_GAIN = 0.008; // ripple height step to surface slope
const KOI_WAKE = 3; // ripple height a koi pushes ahead of itself
const CURSOR_WAKE = 8;
// Wind ripples for the light web: heading (rad), wavelength (px), focusing
// strength (peak curvature of the offset; past 1 the light folds over).
// Headings step by the golden angle so no two run parallel: a few regular
// waves draw long smooth arcs, many scattered ones the net of small cells
// that real pool light makes.
const WAVES: [number, number, number][] = (() => {
  const rand = mulberry32(7);
  return Array.from({ length: WAVE_COUNT }, (_, i) => [i * 2.39996 + rand() * 0.4, 60 + rand() * 90, 0.6 + rand() * 0.1]);
})();
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
  const composite = gl && program(gl, COMPOSITE);
  // The caustic mesh reads the noise and the ripples in its vertex shader.
  const mesh = gl && gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) >= 2 ? program(gl, CAUSTIC_FRAG, CAUSTIC_VERT) : null;
  const caustics = gl && !mesh ? program(gl, CAUSTICS) : null;
  if (!gl || !bake || !composite || (!mesh && !caustics)) {
    // Without WebGL the CSS gradient on the canvas element stands in for water.
    return () => {};
  }
  const simFormat = mesh && !reduced ? floatFormat(gl) : null;
  const simStep = simFormat && program(gl, SIM_STEP);
  const simSlope = simFormat && program(gl, SIM_SLOPE);
  const sim = simFormat && simStep && simSlope ? { format: simFormat, step: simStep, slope: simSlope } : null;
  // Focused light runs to ~6x open water, more where folds overlap; a half-float target holds it
  // linearly (and blends), an 8-bit one only in 1/16 steps.
  const causticHalf = mesh ? halfFloat(gl) : null;
  const causticStore = causticHalf ? 1 : 1 / 16;

  const koi = program(gl, KOI_FRAG, KOI_VERT);
  const koiLayer = program(gl, KOI_LAYER);
  if (!koi || !koiLayer) return () => {};
  // Without these the composite draws straight onto the page, unbloomed.
  const bloomExtract = program(gl, BLOOM_EXTRACT);
  const bloomBlur = program(gl, BLOOM_BLUR);
  const bloomFinal = program(gl, BLOOM_FINAL);
  const bloom = bloomExtract && bloomBlur && bloomFinal ? { extract: bloomExtract, blur: bloomBlur, final: bloomFinal } : null;
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
  const renderTarget = (tex: WebGLTexture | null, w: number, h: number, type: number = gl.UNSIGNED_BYTE) => {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, type, null);
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
  const gridBuf = gl.createBuffer();
  const gridIdx = gl.createBuffer();
  let gridS = CAUSTIC_GRID;
  let gridCount = 0;
  // Ripple state ping-pongs between two float targets; simCur is the latest.
  // The slopes of the last two steps go to a third, which is all the
  // consumers read.
  const simTex = [texture(gl.CLAMP_TO_EDGE), texture(gl.CLAMP_TO_EDGE)];
  const simFb: (WebGLFramebuffer | null)[] = [null, null];
  const slopeTex = texture(gl.CLAMP_TO_EDGE);
  let slopeFb: WebGLFramebuffer | null = null;
  let simCur = 0;
  let simW = 1;
  let simH = 1;
  let simTop = NaN; // page y of the sim's first row
  let simAcc = 0;
  const drops = new Float32Array(64);
  const noDrops = new Float32Array(64);
  // Where each koi and the cursor last pushed the water, for their wakes. The
  // cursor is followed through a short low-pass: pointer events arrive out of
  // step with frames, and raw per-frame jumps kick the water unevenly.
  let wakeFrom: ({ x: number; y: number } | null)[] = [];
  let cursorFrom: { x: number; y: number } | null = null;
  let cursorAt: { x: number; y: number } | null = null;
  // Bloom targets: the scene at canvas resolution, and the glow at a quarter
  // (near) and an eighth (far) of page resolution, each with a twin to
  // ping-pong the blur through.
  const sceneTex = texture(gl.CLAMP_TO_EDGE);
  const acrossTex = texture(gl.CLAMP_TO_EDGE); // the scene, blurred across
  let acrossFb: WebGLFramebuffer | null = null;
  const glowTex = [texture(gl.CLAMP_TO_EDGE), texture(gl.CLAMP_TO_EDGE), texture(gl.CLAMP_TO_EDGE), texture(gl.CLAMP_TO_EDGE)];
  const glowFb: (WebGLFramebuffer | null)[] = [null, null, null, null];
  let sceneFb: WebGLFramebuffer | null = null;
  let sceneW = 1;
  let sceneH = 1;
  let nearW = 1;
  let nearH = 1;
  let farW = 1;
  let farH = 1;
  const fishTex = texture(gl.CLAMP_TO_EDGE);
  let fishFb: WebGLFramebuffer | null = null;
  const atlasTex = texture(gl.CLAMP_TO_EDGE);
  const koiBuf = gl.createBuffer();
  let koiVerts = new Float32Array(0);

  let school = makeSchool(0, 1, 0, 1, 1, mulberry32(1));
  let seeded = false;

  // The koi parts: one atlas image plus where each fish's body, tail and fins
  // sit in it (px rectangles). Fish appear once both have loaded. The atlas is
  // a power of two so it can be mipmapped: fish are drawn several times
  // smaller than their parts, which shimmers without mips.
  let kinds: KoiKind[] = [];
  let atlasReady = false;
  void (async () => {
    try {
      type Rect = [number, number, number, number];
      type Meta = { width: number; height: number; fish: { body: Rect; tail: Rect; pec: Rect; pelvic: Rect }[] };
      const meta: Meta = await (await fetch("/koi/atlas.json")).json();
      const img = new Image();
      img.src = "/koi/atlas.webp";
      await img.decode();
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, atlasTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      kinds = meta.fish.map((k) => {
        const part = ([x, y, w, h]: Rect) => ({
          u0: x / meta.width,
          v0: y / meta.height,
          u1: (x + w) / meta.width,
          v1: (y + h) / meta.height,
          aspect: h / w,
          rel: w / k.body[2],
        });
        return { body: part(k.body), tail: part(k.tail), pec: part(k.pec), pelvic: part(k.pelvic) };
      });
      atlasReady = true;
      seeded = false;
    } catch {
      // Without the atlas the pond simply has no fish.
    }
  })();
  const ku = uni(koi);
  const kuBand = ku("uBand");
  const kaPos = gl.getAttribLocation(koi, "aPos");
  const kaUV = gl.getAttribLocation(koi, "aUV");

  const cu = caustics ? uni(caustics) : () => null;
  const cuRes = cu("uRes");
  const cuScale = cu("uScale");
  const cuOrigin = cu("uOrigin");
  const cuTime = cu("uTime");
  const gu = mesh ? uni(mesh) : () => null;
  const guGrid = gu("uGrid");
  const guBand = gu("uBand");
  const guTime = gu("uTime");
  const guShore = gu("uShore");
  const guSimRect = gu("uSimRect");
  const guSimGain = gu("uSimGain");
  const guSimAlpha = gu("uSimAlpha");
  const gaGrid = mesh ? gl.getAttribLocation(mesh, "aGrid") : -1;
  const su = sim ? uni(sim.step) : () => null;
  const suSize = su("uSize");
  const suShift = su("uShift");
  const suDrops = su("uDrops");
  const lu = sim ? uni(sim.slope) : () => null;
  const luSize = lu("uSize");
  const luPrevShift = lu("uPrevShift");
  const mu = uni(composite);
  const muRes = mu("uRes");
  const muScale = mu("uScale");
  const muOrigin = mu("uOrigin");
  const muTime = mu("uTime");
  const muShore = mu("uShore");
  const muBand = mu("uBand");
  const muSimRect = mu("uSimRect");
  const muSimGain = mu("uSimGain");
  const muSimAlpha = mu("uSimAlpha");
  const beMap = bloom && gl.getUniformLocation(bloom.extract, "uMap");
  const bePond = bloom && gl.getUniformLocation(bloom.extract, "uPond");
  const buStep = bloom && gl.getUniformLocation(bloom.blur, "uStep");
  const buSigma = bloom && gl.getUniformLocation(bloom.blur, "uSigma");
  const bfMap = bloom && gl.getUniformLocation(bloom.final, "uMap");
  const bfSigma = bloom && gl.getUniformLocation(bloom.final, "uSigma");
  const kl = uni(koiLayer);
  const klRes = kl("uRes");
  const klScale = kl("uScale");
  const klOrigin = kl("uOrigin");
  const klTime = kl("uTime");
  const klShore = kl("uShore");
  const klBand = kl("uBand");
  const klSimRect = kl("uSimRect");
  const klSimGain = kl("uSimGain");
  const klSimAlpha = kl("uSimAlpha");
  if (bloom) {
    gl.useProgram(bloom.final);
    gl.uniform1i(gl.getUniformLocation(bloom.final, "uScene"), 5);
    gl.uniform1i(gl.getUniformLocation(bloom.final, "uNear"), 6);
    gl.uniform1i(gl.getUniformLocation(bloom.final, "uFar"), 7);
  }
  if (caustics) {
    bindProgram(caustics);
    gl.uniform1i(cu("uNoise"), 0);
  }
  if (mesh) {
    gl.useProgram(mesh);
    gl.uniform1i(gu("uNoise"), 0);
    gl.uniform1i(gu("uSim"), 4);
    gl.uniform1f(gu("uStore"), causticStore);
  }
  // The wind ripples, for the caustics and the view through them alike. The
  // procedural fallback's web isn't made by them, so there they stay at zero.
  const waveK = new Float32Array(WAVES.length * 4);
  const waveA = new Float32Array(WAVES.length);
  WAVES.forEach(([heading, length, strength], i) => {
    const k = (2 * Math.PI) / length;
    // Deep-water dispersion: longer ripples run faster.
    waveK.set([Math.cos(heading) * k, Math.sin(heading) * k, 2.4 * Math.sqrt(k), i * 4.1], i * 4);
    waveA[i] = strength / (k * k);
  });
  for (const p of mesh ? [mesh, composite, koiLayer] : []) {
    gl.useProgram(p);
    gl.uniform4fv(gl.getUniformLocation(p, "uWaveK"), waveK);
    gl.uniform1fv(gl.getUniformLocation(p, "uWaveA"), waveA);
  }
  if (sim) {
    gl.useProgram(sim.step);
    gl.uniform1i(su("uState"), 4);
    gl.useProgram(sim.slope);
    gl.uniform1i(lu("uCur"), 4);
    gl.uniform1i(lu("uPrev"), 5);
  }
  // The procedural fallback stores half its light; its gaps are unlit and its
  // light averages about 0.35.
  const lightMap = mesh ? [1 / causticStore, AMBIENT, SUN, 1] : [2, 1.3, 1.4, 0.35];
  bindProgram(composite);
  gl.uniform1i(mu("uNoise"), 0);
  gl.uniform1i(mu("uCaustics"), 1);
  gl.uniform1i(mu("uSim"), 4);
  gl.uniform4fv(mu("uLight"), lightMap);
  gl.useProgram(koiLayer);
  gl.uniform1i(kl("uNoise"), 0);
  gl.uniform1i(kl("uCaustics"), 1);
  gl.uniform1i(kl("uFish"), 2);
  gl.uniform1i(kl("uSim"), 4);
  gl.uniform4fv(kl("uLight"), lightMap);
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
    causticFb = renderTarget(causticTex, cw, ch, causticHalf?.type);

    if (bloom) {
      sceneW = canvas.width;
      sceneH = Math.min(canvas.height, Math.ceil(bandH * scale) + 2);
      if (sceneFb) gl.deleteFramebuffer(sceneFb);
      sceneFb = renderTarget(sceneTex, sceneW, sceneH);
      if (acrossFb) gl.deleteFramebuffer(acrossFb);
      acrossFb = renderTarget(acrossTex, sceneW, sceneH);
      nearW = Math.ceil(vw / 4);
      nearH = Math.ceil(sceneH / scale / 4);
      farW = Math.ceil(nearW / 2);
      farH = Math.ceil(nearH / 2);
      glowFb.forEach((fb, i) => {
        if (fb) gl.deleteFramebuffer(fb);
        glowFb[i] = i < 2 ? renderTarget(glowTex[i], nearW, nearH) : renderTarget(glowTex[i], farW, farH);
      });
    }
    if (causticHalf) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, causticHalf.filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, causticHalf.filter);
    }

    if (mesh) {
      // One vertex per grid point, indexed in 16 bits, so the spacing widens
      // on screens big enough to need more than 65k of them.
      gridS = CAUSTIC_GRID / quality;
      let cols = 0;
      let rows = 0;
      for (;;) {
        cols = Math.ceil((vw + 2 * CAUSTIC_PAD) / gridS) + 1;
        rows = Math.ceil((bandH + 2 * CAUSTIC_PAD) / gridS) + 1;
        if ((cols + 1) * (rows + 1) <= 65535) break;
        gridS *= 1.1;
      }
      const verts = new Float32Array((cols + 1) * (rows + 1) * 2);
      for (let j = 0, k = 0; j <= rows; j++) for (let i = 0; i <= cols; i++, k += 2) verts.set([i, j], k);
      const index = new Uint16Array(cols * rows * 6);
      for (let j = 0, k = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++, k += 6) {
          const a = j * (cols + 1) + i;
          const b = a + cols + 1;
          index.set([a, a + 1, b, a + 1, b + 1, b], k);
        }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gridIdx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW);
      gridCount = index.length;
    }

    if (sim) {
      // Fresh, level water: ripples don't survive a relayout.
      simW = Math.ceil(vw / SIM_PX);
      simH = Math.ceil(bandH / SIM_PX);
      for (let i = 0; i < 2; i++) {
        if (simFb[i]) gl.deleteFramebuffer(simFb[i]);
        simFb[i] = renderTarget(simTex[i], simW, simH, sim.format.type);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, sim.format.filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, sim.format.filter);
      }
      if (slopeFb) gl.deleteFramebuffer(slopeFb);
      slopeFb = renderTarget(slopeTex, simW, simH, sim.format.type);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, sim.format.filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, sim.format.filter);
      simTop = NaN;
    }
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
      school = makeSchool(kinds.length, vw, s0 + 80, Math.min(top0 + pondH - 80, s0 + vh * 0.8), size, mulberry32(42));
      koiVerts = new Float32Array(KOI_FLOATS_PER_FISH * Math.max(1, school.length));
      gl.bindBuffer(gl.ARRAY_BUFFER, koiBuf);
      gl.bufferData(gl.ARRAY_BUFFER, koiVerts.byteLength, gl.DYNAMIC_DRAW);
      wakeFrom = school.map(() => null);
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
        const count = writeKoiMesh(school, kinds, koiVerts);
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

    // 2. Ripples, stepped at a fixed rate. Wakes are dipoles, a bump where a
    // koi (or the cursor) was and a dip where it is now, so pushing water
    // around never raises the pond; standing still makes nothing.
    gl.activeTexture(gl.TEXTURE4);
    if (sim) {
      const nextTop = Math.floor(bandTop / SIM_PX) * SIM_PX;
      const shift = Number.isNaN(simTop) ? 0 : Math.round((nextTop - simTop) / SIM_PX);
      simTop = nextTop;
      simAcc = Math.min(simAcc + dt, 4 / SIM_HZ);
      let steps = Math.floor(simAcc * SIM_HZ);
      simAcc -= steps / SIM_HZ;
      if (shift !== 0 && steps === 0) steps = 1;
      const raw = pointer.active ? { x: pointer.x, y: pointer.y + top } : null;
      const wet = raw && raw.y > shore.at(raw.x) + 6;
      if (raw && wet) {
        const k = cursorAt ? 1 - Math.exp(-dt * 30) : 1;
        cursorAt = cursorAt ? { x: cursorAt.x + (raw.x - cursorAt.x) * k, y: cursorAt.y + (raw.y - cursorAt.y) * k } : raw;
      } else cursorAt = null;
      if (steps > 0) {
        drops.fill(0);
        let n = 0;
        const wake = (from: { x: number; y: number }, to: { x: number; y: number }, r: number, h: number) => {
          if (n > 14) return;
          drops.set([from.x / SIM_PX, (from.y - simTop) / SIM_PX, r / SIM_PX, h], n++ * 4);
          drops.set([to.x / SIM_PX, (to.y - simTop) / SIM_PX, r / SIM_PX, -h], n++ * 4);
        };
        if (atlasReady) {
          school.forEach((f, i) => {
            const head = { x: f.pts[0].x, y: f.pts[0].y };
            const from = wakeFrom[i];
            if (from) wake(from, head, Math.max(18, f.width), KOI_WAKE);
            wakeFrom[i] = head;
          });
        }
        if (cursorAt && cursorFrom) wake(cursorFrom, cursorAt, 24, CURSOR_WAKE);
        cursorFrom = cursorAt;

        gl.viewport(0, 0, simW, simH);
        bindProgram(sim.step);
        gl.uniform2f(suSize, simW, simH);
        for (let i = 0; i < steps; i++) {
          gl.uniform1f(suShift, i === 0 ? shift : 0);
          gl.uniform4fv(suDrops, i === 0 ? drops : noDrops);
          gl.bindTexture(gl.TEXTURE_2D, simTex[simCur]);
          gl.bindFramebuffer(gl.FRAMEBUFFER, simFb[1 - simCur]);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          simCur = 1 - simCur;
        }
        // Ping-pong leaves the step before the latest in the other target.
        bindProgram(sim.slope);
        gl.uniform2f(luSize, simW, simH);
        gl.uniform1f(luPrevShift, steps === 1 ? shift : 0);
        gl.bindTexture(gl.TEXTURE_2D, simTex[simCur]);
        gl.activeTexture(gl.TEXTURE5);
        gl.bindTexture(gl.TEXTURE_2D, simTex[1 - simCur]);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, slopeFb);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, sim ? slopeTex : null);
    const simGain = sim ? SIM_GAIN : 0;
    const simY = sim ? simTop : 0;
    const simAlpha = sim ? simAcc * SIM_HZ : 0;

    // 3. Caustics for the band.
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, causticFb);
    gl.viewport(0, 0, cw, ch);
    if (mesh) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(mesh);
      gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf);
      gl.enableVertexAttribArray(gaGrid);
      gl.vertexAttribPointer(gaGrid, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gridIdx);
      // The grid is pinned to page multiples of its spacing, so scrolling
      // doesn't resample the surface and shimmer the web.
      gl.uniform3f(guGrid, -Math.ceil(CAUSTIC_PAD / gridS) * gridS, Math.floor((bandTop - CAUSTIC_PAD) / gridS) * gridS, gridS);
      gl.uniform3f(guBand, vw, bandTop, bandH);
      gl.uniform1f(guTime, t);
      gl.uniform3f(guShore, shore.base(), shore.amp(), vw);
      gl.uniform4f(guSimRect, 0, simY, simW * SIM_PX, simH * SIM_PX);
      gl.uniform1f(guSimGain, simGain);
      gl.uniform1f(guSimAlpha, simAlpha);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.drawElements(gl.TRIANGLES, gridCount, gl.UNSIGNED_SHORT, 0);
      gl.disable(gl.BLEND);
      gl.disableVertexAttribArray(gaGrid);
    } else if (caustics) {
      bindProgram(caustics);
      gl.uniform2f(cuRes, cw, ch);
      gl.uniform1f(cuScale, cw / vw);
      gl.uniform1f(cuOrigin, bandTop);
      gl.uniform1f(cuTime, t);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // 4. Composite the band's canvas rows: into the scene texture to be
    // bloomed (its row 0 the band's bottom row), or straight onto the page.
    bindProgram(composite);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, causticTex);
    const rowTop = Math.max(0, Math.floor((bandTop - top0) * scale));
    const rowBottom = Math.min(canvas.height, Math.ceil((bandTop + bandH - top0) * scale), rowTop + sceneH);
    const rows = rowBottom - rowTop;
    if (bloom) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFb);
      gl.viewport(0, 0, sceneW, rows);
      gl.uniform2f(muRes, canvas.width, rows);
      gl.uniform1f(muOrigin, top0 + rowTop / scale);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, canvas.height - rowBottom, canvas.width, rows);
      gl.uniform2f(muRes, canvas.width, canvas.height);
      gl.uniform1f(muOrigin, top0);
    }
    gl.uniform1f(muScale, scale);
    gl.uniform1f(muTime, t);
    gl.uniform3f(muShore, shore.base(), shore.amp(), vw);
    gl.uniform3f(muBand, vw, bandTop, bandH);
    gl.uniform4f(muSimRect, 0, simY, simW * SIM_PX, simH * SIM_PX);
    gl.uniform1f(muSimGain, simGain);
    gl.uniform1f(muSimAlpha, simAlpha);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // The layers from here are the design's, bottom up: Pond (with its
    // Bloom), Pond blur, Koi.
    if (bloom) {
      // 5. Bloom: extract, blur near (quarter res), halve and blur far
      // (eighth res). Then the pond blur, across here and down in the final
      // pass, which adds the glow and writes the page's band rows.
      const pass = (p: WebGLProgram, fb: WebGLFramebuffer | null, w: number, h: number, src: WebGLTexture | null) => {
        bindProgram(p);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.viewport(0, 0, w, h);
        gl.activeTexture(gl.TEXTURE5);
        gl.bindTexture(gl.TEXTURE_2D, src);
        gl.uniform1i(gl.getUniformLocation(p, p === bloom.extract ? "uScene" : "uSrc"), 5);
        gl.uniform2f(gl.getUniformLocation(p, "uSize"), w, h);
      };
      const blur = (fb: WebGLFramebuffer | null, w: number, h: number, src: WebGLTexture | null, sx: number, sy: number, sigma: number) => {
        pass(bloom.blur, fb, w, h, src);
        gl.uniform2f(buStep, sx, sy);
        gl.uniform1f(buSigma, sigma);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      };
      pass(bloom.extract, glowFb[0], nearW, nearH, sceneTex);
      gl.uniform4f(beMap, sceneW, sceneH, rowBottom, scale);
      gl.uniform2f(bePond, pondH, vw);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      blur(glowFb[1], nearW, nearH, glowTex[0], 0, 1 / nearH, 6);
      blur(glowFb[0], nearW, nearH, glowTex[1], 1 / nearW, 0, 6);
      blur(glowFb[2], farW, farH, glowTex[0], 0, 2 / nearH, 6);
      blur(glowFb[3], farW, farH, glowTex[2], 1 / farW, 0, 6);
      blur(acrossFb, sceneW, sceneH, sceneTex, 1 / sceneW, 0, POND_BLUR * scale);

      bindProgram(bloom.final);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, canvas.height - rowBottom, canvas.width, rows);
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, acrossTex);
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_2D, glowTex[0]);
      gl.activeTexture(gl.TEXTURE7);
      gl.bindTexture(gl.TEXTURE_2D, glowTex[3]);
      gl.uniform3f(bfMap, sceneW, sceneH, canvas.height - rowBottom);
      gl.uniform1f(bfSigma, POND_BLUR * scale);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // 6. The koi and their shadows over it, sharp, still in the band's rows.
    bindProgram(koiLayer);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, canvas.height - rowBottom, canvas.width, rows);
    gl.uniform2f(klRes, canvas.width, canvas.height);
    gl.uniform1f(klScale, scale);
    gl.uniform1f(klOrigin, top0);
    gl.uniform1f(klTime, t);
    gl.uniform3f(klShore, shore.base(), shore.amp(), vw);
    gl.uniform3f(klBand, vw, bandTop, bandH);
    gl.uniform4f(klSimRect, 0, simY, simW * SIM_PX, simH * SIM_PX);
    gl.uniform1f(klSimGain, simGain);
    gl.uniform1f(klSimAlpha, simAlpha);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    clearTimeout(relayout);
    ro.disconnect();
    removeEventListener("resize", onResize);
  };
}

function renders(gl: WebGLRenderingContext, type: number) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, type, null);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  gl.deleteTexture(t);
  return ok;
}

// Half float, if it renders. Unlike full float it can also be blended into.
function halfFloat(gl: WebGLRenderingContext) {
  const half = gl.getExtension("OES_texture_half_float");
  gl.getExtension("EXT_color_buffer_half_float");
  if (!half || !renders(gl, half.HALF_FLOAT_OES)) return null;
  return { type: half.HALF_FLOAT_OES, filter: gl.getExtension("OES_texture_half_float_linear") ? gl.LINEAR : gl.NEAREST };
}

// The ripple sim needs a float colour buffer: full float if it renders, else
// half float. Linear filtering is optional; the sim reads texel centres.
function floatFormat(gl: WebGLRenderingContext) {
  if (gl.getExtension("OES_texture_float") && renders(gl, gl.FLOAT)) {
    return { type: gl.FLOAT, filter: gl.getExtension("OES_texture_float_linear") ? gl.LINEAR : gl.NEAREST };
  }
  return halfFloat(gl);
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
