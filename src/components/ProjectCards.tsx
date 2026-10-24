"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { GlassCard } from "@/components/GlassCard";
import { ProjectView } from "@/components/ProjectView";
import { projects, type Project } from "@/content/site";
import { SCATTER_EVENT } from "@/lib/koi";
import { shoreAt } from "@/lib/shoreline";

const href = (p: Project) => `/projects/${p.slug}`;

// Where the clicked card's name was on screen, as the flight starts from it.
type Opening = { project: Project; from: DOMRect; fromSize: number; fromLine: number };

// The project cards. Clicking one opens its page in place: the pond floor
// rises up the screen, everything behind blurs into plain water, the koi
// dart off the sides, and the card's name grows into the page's title. Only
// then does the router move to the page, which draws exactly that last frame.
export function ProjectCards() {
  const router = useRouter();
  const [opening, setOpening] = useState<Opening | null>(null);

  // Capture phase, so the title's Link sees the click already handled. The
  // card's own outbound links, and new-tab clicks, are left as links.
  const open = (e: MouseEvent<HTMLElement>, p: Project) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = (e.target as Element).closest("a");
    if (link && !link.hasAttribute("data-open")) return;
    e.preventDefault();
    if (opening) return;
    // GlassCard draws its content twice (a sizing copy and the glass); the
    // glass's, the visible one, is measured.
    const name = [...e.currentTarget.querySelectorAll("h3")].at(-1);
    if (!name || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      router.push(href(p));
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(name);
    const text = range.getBoundingClientRect();
    const box = name.getBoundingClientRect();
    const cs = getComputedStyle(name);
    setOpening({ project: p, from: new DOMRect(text.left, box.top, text.width, box.height), fromSize: parseFloat(cs.fontSize), fromLine: box.height });
  };

  // Next keeps this page, hidden, for the back button. Once the project page
  // has replaced it, it's put back as it was before the click, or going back
  // would play the opening again.
  const close = () => setOpening(null);

  return (
    <>
      <ol className="grid max-w-3xl gap-4">
        {projects.map((p) => (
          <li key={p.slug} onClickCapture={(e) => open(e, p)} className="cursor-pointer">
            <GlassCard>
              <div className="flex flex-col gap-3 p-6 text-ink">
                <h3 className={`font-display text-2xl font-semibold ${opening?.project === p ? "invisible" : ""}`}>
                  <Link href={href(p)} data-open="">
                    {p.name}
                  </Link>
                </h3>
                <p className="leading-relaxed text-muted">{p.summary}</p>
                <p className="font-mono text-xs text-muted">{p.stack.join(" · ")}</p>
                <div className="flex flex-wrap gap-x-5 gap-y-2 pt-1 text-sm">
                  {p.links.map((l) => (
                    <a
                      key={l.href}
                      href={l.href}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium underline decoration-ink/30 underline-offset-4 transition-colors hover:text-moss hover:decoration-moss"
                    >
                      {l.label} ↗
                    </a>
                  ))}
                </div>
              </div>
            </GlassCard>
          </li>
        ))}
      </ol>
      {opening && createPortal(<OpeningProject opening={opening} onDone={() => router.push(href(opening.project))} onLeft={close} />, document.body)}
    </>
  );
}

const DURATION = 900; // ms
const EDGE = 140; // px: the rising water's soft top edge
const EASE = "cubic-bezier(0.65, 0, 0.35, 1)";

function OpeningProject({ opening, onDone, onLeft }: { opening: Opening; onDone: () => void; onLeft: () => void }) {
  const blur = useRef<HTMLDivElement>(null);
  const water = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const flight = useRef<HTMLDivElement>(null);
  const asCard = useRef<HTMLSpanElement>(null);
  const asTitle = useRef<HTMLSpanElement>(null);
  const done = useRef(onDone);
  const left = useRef(onLeft);

  useLayoutEffect(() => {
    if (!blur.current || !water.current || !fill.current || !view.current || !title.current || !flight.current || !asCard.current || !asTitle.current) return;
    // The flight sits on the page's title, and starts scaled down onto the
    // card's name. Both spans share the title's line box (its font size), so
    // the start is nudged to centre that in the card name's taller one.
    const to = title.current.getBoundingClientRect();
    const size = parseFloat(getComputedStyle(title.current).fontSize);
    const { from, fromSize, fromLine } = opening;
    const s = fromSize / size;
    Object.assign(flight.current.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, fontSize: `${size}px` });
    const dx = from.left - to.left;
    const dy = from.top - to.top + (fromLine - fromSize) / 2;

    // The floor rises from the waterline on screen; from the bottom of the
    // screen when the shore is off the top or nearly so, so the rise is seen.
    const vh = innerHeight;
    const shore = shoreAt(innerWidth / 2, innerWidth, vh) - scrollY;
    const start = shore > vh * 0.25 && shore < vh ? shore : vh;
    water.current.style.height = `${vh + EDGE}px`;

    dispatchEvent(new Event(SCATTER_EVENT));
    const run = (el: HTMLElement, frames: Keyframe[], o: KeyframeAnimationOptions) => el.animate(frames, { duration: DURATION, fill: "both", ...o });
    const animations = [
      run(water.current, [{ transform: `translateY(${start - EDGE / 2}px)`, opacity: 0 }, { opacity: 1, offset: 0.3 }, { transform: `translateY(${-EDGE}px)`, opacity: 1 }], {
        easing: "cubic-bezier(0.5, 0, 0.25, 1)",
      }),
      run(blur.current, [{ opacity: 0 }, { opacity: 1 }], { duration: DURATION * 0.6, easing: "ease-out" }),
      run(fill.current, [{ opacity: 0 }, { opacity: 1 }], { delay: DURATION * 0.35, duration: DURATION * 0.65, easing: "ease-in-out" }),
      run(flight.current, [{ transform: `translate(${dx}px, ${dy}px) scale(${s})` }, { transform: "none" }], { easing: EASE }),
      run(asCard.current, [{ opacity: 1 }, { opacity: 1, offset: 0.15 }, { opacity: 0, offset: 0.6 }, { opacity: 0 }], {}),
      run(asTitle.current, [{ opacity: 0 }, { opacity: 0, offset: 0.15 }, { opacity: 1, offset: 0.6 }, { opacity: 1 }], {}),
      run(view.current, [{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }], { delay: DURATION * 0.5, duration: DURATION * 0.5, easing: "ease-out" }),
    ];
    const finish = done.current;
    const leave = left.current;
    let live = true;
    let navigated = false;
    Promise.all(animations.map((a) => a.finished)).then(() => {
      if (!live) return;
      navigated = true;
      finish();
    }, () => {});

    // The page underneath stays put while it plays.
    const hold = (e: Event) => e.preventDefault();
    addEventListener("wheel", hold, { passive: false });
    addEventListener("touchmove", hold, { passive: false });
    return () => {
      live = false;
      for (const a of animations) a.cancel();
      removeEventListener("wheel", hold);
      removeEventListener("touchmove", hold);
      if (navigated) leave();
    };
  }, [opening]);

  return (
    <div aria-hidden="true" className="fixed inset-0 z-50">
      <div ref={blur} className="absolute inset-0 opacity-0 backdrop-blur-[10px]" />
      <div
        ref={water}
        className="absolute inset-x-0 top-0 bg-pond/55 backdrop-blur-[18px]"
        style={{ maskImage: `linear-gradient(transparent, black ${EDGE}px)`, transform: "translateY(100vh)" }}
      />
      <div ref={fill} className="absolute inset-0 bg-pond opacity-0" />
      <div ref={view} inert className="absolute inset-0 flex flex-col overflow-hidden opacity-0">
        <ProjectView project={opening.project} titleRef={title} hideTitle />
      </div>
      <div ref={flight} className="absolute origin-top-left leading-none will-change-transform">
        <span ref={asCard} className="absolute top-0 left-0 font-display font-semibold whitespace-nowrap text-ink">
          {opening.project.name}
        </span>
        <span ref={asTitle} className="absolute inset-x-0 top-0 font-signature text-foam italic opacity-0 [text-shadow:0_1px_8px_rgb(0_40_45/0.5)]">
          {opening.project.name}
        </span>
      </div>
    </div>
  );
}
