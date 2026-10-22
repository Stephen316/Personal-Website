// Everything a visitor reads lives here. Edit this file, not the components.

export type Project = {
  name: string;
  summary: string;
  stack: string[];
  links: { label: string; href: string }[];
};

export const site = {
  name: "Stephen Harcourt",
  // TODO: rewrite in your own words.
  intro: "I build apps and tools, mostly for problems I have myself.",
  github: "https://github.com/Stephen316",
};

// Public GitHub repos, most recently worked on first.
export const projects: Project[] = [
  {
    name: "DCU Timetables",
    summary:
      "Your DCU timetable, groups, labs and deadlines on your phone and your Mac, built on DCU's live public timetable API. Free for anyone with a DCU email.",
    stack: ["TypeScript", "React Native", "Expo", "SwiftUI widgets"],
    links: [
      { label: "Get the app", href: "https://stephen316.github.io/DCU-Timetables/" },
      { label: "Source", href: "https://github.com/Stephen316/DCU-Timetables" },
    ],
  },
  {
    name: "SuperFit",
    summary:
      "An iOS fitness, macro and health tracker for body recomposition. It learns your real energy expenditure from what you eat against your bodyweight trend, instead of adding exercise calories back.",
    stack: ["Swift", "SwiftUI", "SwiftData", "HealthKit"],
    links: [{ label: "Source", href: "https://github.com/Stephen316/SuperFit" }],
  },
  {
    name: "BlenderGPT",
    summary:
      "A Blender add-on that aims to turn a typed instruction into Blender actions. Early days: the panel is in, the AI commands come next.",
    stack: ["Python", "Blender"],
    links: [{ label: "Source", href: "https://github.com/Stephen316/blendergpt" }],
  },
];
