"use client";

import { useLayoutEffect, useRef } from "react";
import { startPond } from "@/lib/pond";

// Open water: the home page's pond with its light still moving but no koi or
// ripples in it, pinned to the screen.
type Water = { canvas: HTMLCanvasElement; stop: () => void };

export function openWater(): Water {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.className = "block size-full";
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  return { canvas, stop: startPond(canvas, null, reduced ? "still" : "calm") };
}

// The opening transition raises open water over the home page, then leaves
// it here for the page it opens, so the light runs on without a cut.
let waiting: Water | null = null;
export function handOff(water: Water) {
  waiting?.stop();
  waiting = water;
}

// The project pages' background. It takes the water the opening left, or,
// arriving any other way, starts its own and fades it up from the page's
// water colour.
export function PondBackdrop() {
  const box = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const water = waiting ?? openWater();
    if (!waiting) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 800, easing: "ease-out" });
    waiting = null;
    el.append(water.canvas);
    // Left waiting rather than stopped, for a remount straight after (Strict
    // Mode does one) to pick up.
    return () => {
      handOff(water);
      setTimeout(() => {
        if (waiting !== water) return;
        water.stop();
        water.canvas.remove();
        waiting = null;
      });
    };
  }, []);

  return <div ref={box} aria-hidden="true" className="pointer-events-none fixed inset-0 -z-20" />;
}
