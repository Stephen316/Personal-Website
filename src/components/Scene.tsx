"use client";

import { useEffect, useRef } from "react";
import { startGarden } from "@/lib/garden";
import { startPond } from "@/lib/pond";

// The page background: the zen garden's sand on top of a koi pond. Both are
// ordinary absolutely positioned layers in the page, so the browser scrolls
// them with the content: the sand ends in a hard, curved shoreline and the
// pond canvas runs from just above it to the bottom of the page.
export function Scene() {
  const sandLayer = useRef<HTMLDivElement>(null);
  const sand = useRef<HTMLCanvasElement>(null);
  const stones = useRef<HTMLCanvasElement>(null);
  const floor = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!sandLayer.current || !sand.current || !stones.current || !floor.current) return;
    const layer = sandLayer.current;
    const sandCanvas = sand.current;
    const stoneCanvas = stones.current;
    const pondCanvas = floor.current;

    // Sand covers the first screen and a bit more; the shoreline wave sits
    // in that extra margin, so it never cuts through the hero or the stones.
    let w = 0;
    let h = 0;
    let amp = 0;
    const shore = (x: number) => {
      const u = x / w;
      return h - amp * 1.15 + amp * (Math.sin(u * Math.PI * 2.2 + 0.8) * 0.7 + Math.sin(u * Math.PI * 4.6 + 2.1) * 0.3);
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
      stopGarden = startGarden(sandCanvas, stoneCanvas, () => ({ w, h }), (x, y) => y < shore(x) - 4, titleRight);
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
    </>
  );
}
