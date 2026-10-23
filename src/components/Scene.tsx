"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { startGarden } from "@/lib/garden";
import { startPond } from "@/lib/pond";
import { groovesTop, placePiece, SHORE_PIECES, shoreAt, type ShorePiece } from "@/lib/shoreline";

// The page background: the zen garden's sand on top of a koi pond. Both are
// ordinary absolutely positioned layers in the page, so the browser scrolls
// them with the content: the sand ends in a hard, curved shoreline, edged
// with moss and boulders, and the pond canvas runs from just above it to the
// bottom of the page.
export function Scene() {
  const sandLayer = useRef<HTMLDivElement>(null);
  const sand = useRef<HTMLCanvasElement>(null);
  const stones = useRef<HTMLCanvasElement>(null);
  const floor = useRef<HTMLCanvasElement>(null);
  const shoreLayer = useRef<HTMLDivElement>(null);
  const overLayer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sandLayer.current || !sand.current || !stones.current || !floor.current || !shoreLayer.current || !overLayer.current) return;
    const layer = sandLayer.current;
    const sandCanvas = sand.current;
    const stoneCanvas = stones.current;
    const pondCanvas = floor.current;
    const edges: [HTMLElement, ShorePiece[]][] = [
      [shoreLayer.current, UNDER],
      [overLayer.current, OVER],
    ];

    let w = 0;
    let h = 0;
    let amp = 0;
    const shore = (x: number) => shoreAt(x, w, innerHeight);
    const place = (el: HTMLElement, p: ShorePiece) => {
      const r = placePiece(p, w, innerHeight);
      el.style.left = `${r.left}px`;
      el.style.top = `${r.top}px`;
      el.style.width = `${r.width}px`;
      el.style.height = `${r.height}px`;
      return r.top + r.height;
    };
    const layout = () => {
      w = innerWidth;
      h = Math.round(innerHeight * 1.3);
      amp = Math.min(innerHeight * 0.07, 70);
      layer.style.height = `${h}px`;
      const pts = ["0px 0px", `${w}px 0px`];
      for (let i = 48; i >= 0; i--) {
        const x = (w * i) / 48;
        pts.push(`${x.toFixed(1)}px ${shore(x).toFixed(1)}px`);
      }
      layer.style.clipPath = `polygon(${pts.join(",")})`;
      // The edge layers clip the pieces hanging off the sides, and their
      // shadows scale with them.
      for (const [edge, pieces] of edges) {
        let bottom = 0;
        pieces.forEach((p, i) => (bottom = Math.max(bottom, place(edge.children[i] as HTMLElement, p))));
        edge.style.height = `${Math.ceil(bottom)}px`;
        edge.style.setProperty("--s", String(w / 1440));
      }
    };
    // The h1 is a full-width block, so measure its text, not the element.
    const titleRight = () => {
      const title = document.querySelector("main h1");
      if (!title) return 0;
      const range = document.createRange();
      range.selectNodeContents(title);
      return range.getBoundingClientRect().right;
    };
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let stopGarden = () => {};
    let stopPond = () => {};
    let started = false;
    // A page loaded in a hidden tab or zero-size frame has no viewport yet;
    // nothing can be sized until it does, so start on the first real size.
    const start = () => {
      if (started || !innerWidth || !innerHeight) return;
      started = true;
      layout();
      addEventListener("resize", layout);
      stopGarden = startGarden(sandCanvas, stoneCanvas, () => ({ w, h }), (x, y) => y < shore(x) - 4, titleRight, {
        at: shore,
        grooves: (x) => groovesTop(x, w, innerHeight),
      });
      stopPond = startPond(pondCanvas, { base: () => h - amp * 1.15, amp: () => amp, at: shore }, reduced);
    };
    start();
    if (!started) addEventListener("resize", start);

    return () => {
      removeEventListener("resize", start);
      removeEventListener("resize", layout);
      stopGarden();
      stopPond();
    };
  }, []);

  return (
    <>
      <canvas
        ref={floor}
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-20 w-full bg-[#0a666a]"
      />
      <div ref={sandLayer} aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[130vh] [&>canvas]:blur-[0.4px]">
        <canvas ref={sand} className="absolute inset-0 h-full w-full" />
        <canvas ref={stones} className="absolute inset-0 h-full w-full" />
      </div>
      <div ref={shoreLayer} aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 -z-[5] overflow-hidden">
        {UNDER.map((p, i) => (
          <div key={i} className="absolute">
            <ShoreImage piece={p} />
          </div>
        ))}
      </div>
      {/* In the design one boulder is the topmost layer, over the text. */}
      <div ref={overLayer} aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 z-10 overflow-hidden">
        {OVER.map((p, i) => (
          <div key={i} className="absolute">
            <ShoreImage piece={p} />
          </div>
        ))}
      </div>
    </>
  );
}

const UNDER = SHORE_PIECES.filter((p) => !p.overContent);
const OVER = SHORE_PIECES.filter((p) => p.overContent);

// Figma's shadows on these cut-outs follow their outlines, which is
// drop-shadow, not box-shadow; lengths are in design px, scaled by --s.
const SHADOWS = {
  rock: "drop-shadow(calc(-3px * var(--s)) calc(4px * var(--s)) calc(5px * var(--s)) rgb(19 22 9 / 0.78)) drop-shadow(calc(5px * var(--s)) calc(9px * var(--s)) calc(13px * var(--s)) rgb(33 29 17 / 0.38))",
  moss: "drop-shadow(calc(1px * var(--s)) calc(2px * var(--s)) calc(3px * var(--s)) rgb(48 43 20 / 0.23))",
};

// A design image inside its placed bounding box: its own box centred in that,
// turned, and filled as the design fills it.
function ShoreImage({ piece }: { piece: ShorePiece }) {
  const [, , bw, bh] = piece.box;
  const [iw, ih] = piece.inner ?? [bw, bh];
  const frame: CSSProperties = {
    position: "absolute",
    left: `${((bw - iw) / 2 / bw) * 100}%`,
    top: `${((bh - ih) / 2 / bh) * 100}%`,
    width: `${(iw / bw) * 100}%`,
    height: `${(ih / bh) * 100}%`,
    transform: piece.rotate ? `rotate(${piece.rotate}deg)` : undefined,
    filter: piece.shadow ? SHADOWS[piece.shadow] : undefined,
  };
  const fit = piece.fit;
  return (
    <div style={frame}>
      {typeof fit === "string" ? (
        // eslint-disable-next-line @next/next/no-img-element -- placed and cropped by hand to match the design
        <img src={piece.src} alt="" draggable={false} decoding="async" className="absolute inset-0 size-full max-w-none" style={{ objectFit: fit }} />
      ) : (
        <div className="absolute inset-0 overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element -- placed and cropped by hand to match the design */}
          <img src={piece.src} alt="" draggable={false} decoding="async" className="absolute w-full max-w-none" style={{ height: `${fit.h}%`, top: `${fit.top}%`, left: `${fit.left}%` }} />
        </div>
      )}
    </div>
  );
}
