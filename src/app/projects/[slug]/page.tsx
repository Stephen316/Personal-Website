import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PondBackdrop } from "@/components/PondBackdrop";
import { ProjectView } from "@/components/ProjectView";
import { projects, site } from "@/content/site";

export function generateStaticParams() {
  return projects.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: PageProps<"/projects/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const project = projects.find((p) => p.slug === slug);
  return project ? { title: `${project.name} — ${site.name}`, description: project.summary } : {};
}

export default async function ProjectPage({ params }: PageProps<"/projects/[slug]">) {
  const { slug } = await params;
  const project = projects.find((p) => p.slug === slug);
  if (!project) notFound();
  return (
    <div className="pond-page flex flex-1 flex-col">
      <PondBackdrop />
      <ProjectView project={project} />
    </div>
  );
}
