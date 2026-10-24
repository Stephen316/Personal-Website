import { ProjectCards } from "@/components/ProjectCards";
import { Scene } from "@/components/Scene";
import { site } from "@/content/site";

export default function Home() {
  return (
    <>
      <Scene />

      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 sm:px-6 lg:mr-auto lg:ml-[max(0px,calc(50%-588px))]">
        <header className="relative -top-[7px] flex h-16 items-center justify-between">
          <span className="font-medium">{site.name}</span>
          <a href={site.github} target="_blank" rel="noreferrer" className="text-sm text-muted transition-colors hover:text-ink">
            GitHub
          </a>
        </header>

        <main className="flex-1">
          <section className="flex min-h-[calc(100svh-4rem)] flex-col justify-center pb-24 sm:pb-52">
            <h1 className="font-signature text-6xl font-normal italic sm:text-8xl">{site.name}</h1>
            <p className="mt-5 max-w-md text-lg text-muted">{site.intro}</p>
            <p className="mt-10 font-mono text-xs text-muted">
              <span className="hidden sm:inline">Move your cursor across the sand to rake it. </span>
              Scroll down to the pond.
            </p>
          </section>

          <section id="projects" aria-labelledby="projects-title" className="pt-[calc(45vh-58px)] pb-32">
            <h2 id="projects-title" className="mb-6 font-display text-3xl font-semibold text-foam [text-shadow:0_1px_8px_rgb(0_40_45/0.5)]">
              Projects
            </h2>
            <ProjectCards />
          </section>
        </main>

        <footer className="flex h-16 items-center text-sm text-foam/80">
          <a href={site.github} target="_blank" rel="noreferrer" className="transition-colors hover:text-foam">
            github.com/Stephen316
          </a>
        </footer>
      </div>
    </>
  );
}
