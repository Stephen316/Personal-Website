import { GlassCard } from "@/components/GlassCard";
import { Scene } from "@/components/Scene";
import { projects, site } from "@/content/site";
import koiCredits from "../../public/koi/credits.json";

export default function Home() {
  return (
    <>
      <Scene />

      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 sm:px-6">
        <header className="flex h-16 items-center justify-between">
          <span className="font-medium">{site.name}</span>
          <a href={site.github} target="_blank" rel="noreferrer" className="text-sm text-muted transition-colors hover:text-ink">
            GitHub
          </a>
        </header>

        <main className="flex-1">
          <section className="flex min-h-[calc(100svh-4rem)] flex-col justify-center pb-24">
            <h1 className="font-signature text-6xl font-normal italic sm:text-8xl">{site.name}</h1>
            <p className="mt-5 max-w-md text-lg text-muted">{site.intro}</p>
            <p className="mt-10 font-mono text-xs text-muted">
              <span className="hidden sm:inline">Move your cursor across the sand to rake it. </span>
              Scroll down to the pond.
            </p>
          </section>

          <section id="projects" aria-labelledby="projects-title" className="pt-[45vh] pb-32">
            <h2 id="projects-title" className="mb-6 font-display text-3xl font-semibold text-foam [text-shadow:0_1px_8px_rgb(0_40_45/0.5)]">
              Projects
            </h2>
            <ol className="grid max-w-3xl gap-4">
              {projects.map((p) => (
                <li key={p.name}>
                  <GlassCard>
                    <div className="flex flex-col gap-3 p-6 text-ink">
                      <h3 className="font-display text-2xl font-semibold">{p.name}</h3>
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
          </section>
        </main>

        <footer className="flex flex-col gap-2 py-6 text-sm text-foam/80">
          <a href={site.github} target="_blank" rel="noreferrer" className="transition-colors hover:text-foam">
            github.com/Stephen316
          </a>
          {/* The koi are cut from these Wikimedia Commons photos; their licences
              require credit, and the cut-outs share the same licence. */}
          <p className="text-xs text-foam/60">
            Koi photos:{" "}
            {koiCredits.map((c, i) => (
              <span key={c.name}>
                {i > 0 && ", "}
                <a href={c.page} target="_blank" rel="noreferrer" className="underline decoration-foam/30 underline-offset-2 hover:text-foam">
                  {c.artist}
                </a>{" "}
                (
                <a href={c.licenseUrl} target="_blank" rel="noreferrer" className="hover:text-foam">
                  {c.license}
                </a>
                )
              </span>
            ))}
            , via Wikimedia Commons; cut out and straightened.
          </p>
        </footer>
      </div>
    </>
  );
}
