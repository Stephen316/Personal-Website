// Everything a visitor reads lives here. Edit this file, not the components.

export type Project = {
  slug: string; // its page is /projects/<slug>
  name: string;
  summary: string;
  stack: string[];
  links: { label: string; href: string }[];
  about?: { what: string; built: string };
};

export const site = {
  name: "Stephen Harcourt",
  // TODO: rewrite in your own words.
  intro: "I build apps and tools, most of the time it's because I'm bored.",
  github: "https://github.com/Stephen316",
};

// Projects, most recently worked on first.
export const projects: Project[] = [
  {
    // TODO: placeholder — replace the summary, stack, links and about.
    slug: "unicad",
    name: "UniCAD",
    summary: "Summary coming soon.",
    stack: ["TBC"],
    links: [],
  },
  {
    slug: "equilibrium",
    name: "Equilibrium",
    summary:
      "Retrofit intelligence for commercial HVAC: wireless room sensors and a local predictive optimiser that work with a building's existing heating and cooling, with no full building management system needed.",
    stack: ["Django", "TypeScript", "React Native", "Thread sensors"],
    links: [{ label: "Website", href: "https://equilibrium.ie" }],
    about: {
      what: "Wireless sensors track temperature, humidity and CO₂ in every room, and a local optimiser plans heating and cooling ahead of demand, working alongside the controls a building already has.",
      built:
        "A Django-backed dashboard with web and native mobile apps, battery sensors on a Thread wireless network, and integrations with existing HVAC equipment.",
    },
  },
  {
    slug: "dcu-timetables",
    name: "DCU Timetables",
    summary:
      "Your DCU timetable, groups, labs and deadlines on your phone and your Mac, built on DCU's live public timetable API. Free for anyone with a DCU email.",
    stack: ["TypeScript", "React Native", "Expo", "SwiftUI widgets"],
    links: [
      { label: "Get the app", href: "https://stephen316.github.io/DCU-Timetables/" },
      { label: "Source", href: "https://github.com/Stephen316/DCU-Timetables" },
    ],
    about: {
      what: "Shows your DCU timetable, groups, labs and deadlines on your phone and your Mac, straight from DCU's live public timetable API. Free for anyone with a DCU email.",
      built: "A React Native app in TypeScript with Expo, plus SwiftUI widgets for the home screen.",
    },
  },
  {
    slug: "superfit",
    name: "SuperFit",
    summary:
      "An iOS fitness, macro and health tracker for body recomposition. It learns your real energy expenditure from what you eat against your bodyweight trend, instead of adding exercise calories back.",
    stack: ["Swift", "SwiftUI", "SwiftData", "HealthKit"],
    links: [{ label: "Source", href: "https://github.com/Stephen316/SuperFit" }],
    about: {
      what: "Learns your real energy expenditure by comparing what you eat with your bodyweight trend, and sets targets from that instead of adding exercise calories back.",
      built: "A native iOS app in Swift and SwiftUI, storing data with SwiftData and reading health data through HealthKit.",
    },
  },
];
