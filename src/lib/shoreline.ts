// The shoreline: the curve where the sand meets the pond, and the moss and
// boulders laid along it in the design (Figma, "Home — Desktop", 1440 x 900).

// The waterline in page px, for a viewport w wide and vh tall. The sand
// covers 1.3 screens; the wave sits in the bottom of that, so it never cuts
// through the hero or the stones.
export function shoreAt(x: number, w: number, vh: number) {
  const amp = Math.min(vh * 0.07, 70);
  const u = x / w;
  return Math.round(vh * 1.3) - amp * 1.15 + amp * (Math.sin(u * Math.PI * 2.2 + 0.8) * 0.7 + Math.sin(u * Math.PI * 4.6 + 2.1) * 0.3);
}

const DESIGN_W = 1440;
const DESIGN_VH = 900;

// One image from the design, as its bounding box there (left, top, width,
// height), the image's own box inside it (width, height, turned by
// `rotate` degrees about the centre), and how the image fills that box:
// `cover`, `contain`, or a crop (the image's height, top and left as
// percentages of the box, its width being the box's).
export type ShorePiece = {
  src: string;
  box: [number, number, number, number];
  inner?: [number, number];
  rotate?: number;
  fit: "cover" | "contain" | { h: number; top: number; left: number };
  shadow?: "rock" | "moss";
  overContent?: boolean; // layered above the page's text, as in the design
};

// Where the grooves raked along the shore begin, in design px above the
// waterline, every 30 px across the page. Measured from the top edge of the
// design's shore-ripples layer, which traces the moss and boulders.
const GROOVES_FROM = [
  241, 250, 261, 263, 259, 245, 243, 245, 251, 260, 269, 272, 272, 267, 254, 238, 225, 213, 208, 208, 206, 206, 206, 213, 227,
  245, 258, 251, 238, 218, 207, 200, 204, 231, 247, 258, 269, 284, 295, 298, 294, 284, 277, 270, 253, 240, 220, 205, 192,
];

// The top of the shore grooves at page x, on a page w x vh. A Catmull-Rom
// curve through the samples: the grooves are spaced square to it, so a kink
// in its slope would step every groove sideways.
export function groovesTop(x: number, w: number, vh: number) {
  const s = w / DESIGN_W;
  const n = GROOVES_FROM.length;
  const i = Math.max(0, Math.min(n - 1.001, x / s / 30));
  const k = Math.floor(i);
  const t = i - k;
  const at = (j: number) => GROOVES_FROM[Math.max(0, Math.min(n - 1, j))];
  const p0 = at(k - 1);
  const p1 = at(k);
  const p2 = at(k + 1);
  const p3 = at(k + 2);
  const above = p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  return shoreAt(x, w, vh) - above * s;
}

// Bottom to top, as layered in the design.
export const SHORE_PIECES: ShorePiece[] = [
  { src: "/shore/shoreline.webp", box: [-15, 870, 1470, 521.41], fit: "contain" },
  { src: "/shore/moss-fringe.webp", box: [112, 912, 634.247, 260.832], inner: [622.64, 226.665], rotate: 176.82, fit: "contain", shadow: "moss" },
  { src: "/shore/moss-fringe.webp", box: [955, 839, 593.583, 406.502], inner: [542.53, 251.135], rotate: -162, fit: "contain", shadow: "moss" },
  { src: "/shore/moss-fringe.webp", box: [497, 904, 646.694, 235.978], inner: [640.361, 216.454], rotate: 178.24, fit: "contain", shadow: "moss" },
  { src: "/shore/shore-boulder-a.webp", box: [-76, 968, 280, 272], fit: { h: 102.75, top: -2.86, left: 0 }, shadow: "rock" },
  { src: "/shore/shore-boulder-b.webp", box: [133, 936, 313, 294], fit: { h: 106.31, top: -5.52, left: -0.03 }, shadow: "rock" },
  { src: "/shore/shore-boulder-c.webp", box: [578, 793, 510.708, 444.883], inner: [436.664, 343.573], rotate: 15, fit: "cover", shadow: "rock" },
  { src: "/shore/shore-boulder-d.webp", box: [971, 881, 332.721, 331.217], inner: [272.115, 269.988], rotate: 15, fit: { h: 100.79, top: -1.04, left: 0 }, shadow: "rock" },
  { src: "/shore/shore-boulder-e.webp", box: [1185.71, 892.55, 451.318, 424.821], inner: [363.952, 319.618], rotate: -20, fit: { h: 113.87, top: -1.73, left: 0 }, shadow: "rock" },
  { src: "/shore/shore-boulder-f.webp", box: [345, 922, 370.008, 312.952], inner: [329.941, 259.602], rotate: -10, fit: "cover", shadow: "rock", overContent: true },
];

// Where a piece goes on a page w x vh: scaled with the width, and pinned to
// the waterline under its centre, so it sits on the shore as in the design
// (exactly so at 1440 x 900) however the wave is stretched.
export function placePiece(p: ShorePiece, w: number, vh: number) {
  const s = w / DESIGN_W;
  const [left, top, bw, bh] = p.box;
  const cx = left + bw / 2;
  const cy = top + bh / 2;
  const x = cx * s;
  const y = shoreAt(x, w, vh) + (cy - shoreAt(cx, DESIGN_W, DESIGN_VH)) * s;
  return { left: x - (bw * s) / 2, top: y - (bh * s) / 2, width: bw * s, height: bh * s };
}
