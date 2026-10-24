import Link from "next/link";
import type { Ref } from "react";
import { site, type Project } from "@/content/site";

const PANEL = "rounded-[20px] bg-white/55 backdrop-blur-[24px]";
const SHADOW = "[text-shadow:0_1px_8px_rgb(0_40_45/0.5)]";

// A project's page, over plain pond water (the wrapper supplies the water).
// The opening transition on the home page draws this same view, so the page
// it navigates to lines up with its last frame. The title is a single size
// per breakpoint with leading-none: the transition flies the card's name
// into it and relies on its line box being its font size.
export function ProjectView({ project, titleRef, hideTitle }: { project: Project; titleRef?: Ref<HTMLHeadingElement>; hideTitle?: boolean }) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 sm:px-6 lg:mr-auto lg:ml-[max(0px,calc(50%-588px))]">
      <header className="relative -top-[7px] flex h-16 items-center justify-between text-foam">
        <Link href="/" className="font-medium">
          {site.name}
        </Link>
        <a href={site.github} target="_blank" rel="noreferrer" className="text-sm text-foam/80 transition-colors hover:text-foam">
          GitHub
        </a>
      </header>

      <main className="flex max-w-3xl flex-1 flex-col gap-7 pt-10 pb-24">
        <Link href="/#projects" className="self-start text-sm font-medium text-foam/90 transition-colors hover:text-foam">
          ← All projects
        </Link>
        <h1 ref={titleRef} className={`font-signature text-6xl leading-none font-normal text-foam italic sm:text-8xl ${SHADOW} ${hideTitle ? "invisible" : ""}`}>
          {project.name}
        </h1>

        <section className={`${PANEL} flex flex-col gap-4 p-8`}>
          <p className="text-lg leading-7 text-muted">{project.summary}</p>
          <p className="font-mono text-xs text-muted">{project.stack.join(" · ")}</p>
          {project.links.length > 0 && (
            <div className="flex flex-wrap gap-x-5 gap-y-2 pt-1 text-sm">
              {project.links.map((l) => (
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
          )}
        </section>

        {project.about && (
          <>
            <h2 className={`font-display text-3xl font-semibold text-foam ${SHADOW}`}>About</h2>
            <section className={`${PANEL} flex flex-col gap-4 p-8`}>
              <h3 className="font-display text-2xl font-semibold">What it does</h3>
              <p className="leading-[26px] text-muted">{project.about.what}</p>
              <h3 className="font-display text-2xl font-semibold">How it&apos;s built</h3>
              <p className="leading-[26px] text-muted">{project.about.built}</p>
            </section>
          </>
        )}
      </main>

      <footer className="flex h-16 items-center text-sm text-foam/80">
        <a href={site.github} target="_blank" rel="noreferrer" className="transition-colors hover:text-foam">
          github.com/Stephen316
        </a>
      </footer>
    </div>
  );
}
