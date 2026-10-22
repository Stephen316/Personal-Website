"use client";

import LiquidGlass from "liquid-glass-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

const FOG = "rounded-[20px] bg-white/55";

// Foggy white liquid glass. liquid-glass-react centres itself with top/left
// 50% and translate(-50%), so it can't sit in normal flow: an invisible copy
// of the content sizes the slot and the glass is pinned to the slot's centre
// at the slot's width. Before hydration the content shows as plain frosted
// white.
export function GlassCard({ children }: { children: ReactNode }) {
  const slot = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = slot.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ready = width > 0;
  return (
    <div ref={slot} className="relative">
      <div aria-hidden={ready || undefined} className={ready ? "invisible" : `${FOG} backdrop-blur-xl`}>
        {children}
      </div>
      {ready && (
        <LiquidGlass
          key={width}
          style={{ position: "absolute", top: "50%", left: "50%" }}
          cornerRadius={20}
          padding="0"
          elasticity={0}
          displacementScale={50}
          blurAmount={0.45}
          saturation={115}
          aberrationIntensity={1.5}
          mode="polar"
        >
          <div style={{ width, textShadow: "none" }} className={`${FOG} font-sans text-base leading-normal font-normal`}>
            {children}
          </div>
        </LiquidGlass>
      )}
    </div>
  );
}
