import type { PageKey } from "../components/Sidebar";
import type {
  CustomFieldModule,
  CustomSectionDefinition,
  SectionParentKey,
} from "../types";
import { customSectionKey } from "./sectionHierarchy";

const pageSegments: Partial<Record<PageKey, string>> = {
  dashboard: "dashboard",
  map: "map",
  researches: "researches",
  documents: "documents",
  archiveRequests: "archive-requests",
  yearMatrix: "year-matrix",
  tasks: "tasks",
  findings: "findings",
  hypotheses: "hypotheses",
  persons: "persons",
  backup: "backups",
};

const segmentPages = new Map(
  Object.entries(pageSegments).map(([page, segment]) => [segment, page as PageKey]),
);

export type AppRoute =
  | { kind: "root" }
  | { kind: "public"; page: "privacy" | "terms" }
  | { kind: "projects" }
  | { kind: "settings"; page: "settings" | "subscription" }
  | {
      kind: "project";
      projectRef: string;
      page: PageKey;
      unresolvedSectionPath?: boolean;
    }
  | { kind: "unknown" };

function sectionSlug(name: string): string {
  return name
    .trim()
    .toLocaleLowerCase()
    .replaceAll("щ", "shch")
    .replaceAll("ж", "zh")
    .replaceAll("ч", "ch")
    .replaceAll("ш", "sh")
    .replaceAll("ю", "iu")
    .replaceAll("я", "ia")
    .replaceAll("є", "ie")
    .replaceAll("ї", "i")
    .replaceAll("й", "i")
    .replaceAll("х", "kh")
    .replaceAll("ц", "ts")
    .replaceAll("ґ", "g")
    .replace(/[абвгдезиклмнопрстуфь]/g, (letter) => ({
      а: "a", б: "b", в: "v", г: "h", д: "d", е: "e", з: "z", и: "y",
      і: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
      с: "s", т: "t", у: "u", ф: "f", ь: "",
    })[letter] ?? "")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "rozdil";
}

function sectionSegment(
  section: CustomSectionDefinition,
  sections: CustomSectionDefinition[],
): string {
  const slug = sectionSlug(section.name);
  const duplicate = sections.some(
    (candidate) =>
      candidate.id !== section.id &&
      candidate.parentKey === section.parentKey &&
      sectionSlug(candidate.name) === slug,
  );
  return duplicate ? `${slug}-${section.id.slice(0, 8)}` : slug;
}

function customSectionSegments(
  section: CustomSectionDefinition,
  sections: CustomSectionDefinition[],
): string[] {
  const chain: CustomSectionDefinition[] = [];
  const seen = new Set<string>();
  let current: CustomSectionDefinition | undefined = section;
  let root: SectionParentKey | null = section.parentKey;

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    root = current.parentKey;
    if (!root?.startsWith("custom:")) break;
    current = sections.find((item) => customSectionKey(item.id) === root);
  }

  const rootSegment =
    root && !root.startsWith("custom:")
      ? pageSegments[root as CustomFieldModule]
      : "custom";
  return [
    rootSegment ?? "custom",
    ...chain.map((item) => sectionSegment(item, sections)),
  ];
}

function findSectionBySegments(
  segments: string[],
  sections: CustomSectionDefinition[],
): CustomSectionDefinition | undefined {
  return sections.find((section) => {
    const candidate = customSectionSegments(section, sections);
    return candidate.length === segments.length &&
      candidate.every((part, index) => part === segments[index]);
  });
}

export function parseAppRoute(
  pathname: string,
  sections: CustomSectionDefinition[] = [],
): AppRoute {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (!parts.length) return { kind: "root" };
  if (parts.length === 1 && parts[0] === "privacy") {
    return { kind: "public", page: "privacy" };
  }
  if (parts.length === 1 && parts[0] === "terms") {
    return { kind: "public", page: "terms" };
  }
  if (parts.length === 1 && parts[0] === "projects") return { kind: "projects" };
  if (parts.length === 1 && parts[0] === "settings") {
    return { kind: "settings", page: "settings" };
  }
  if (parts.length === 2 && parts[0] === "settings" && parts[1] === "subscription") {
    return { kind: "settings", page: "subscription" };
  }
  if (parts[0] !== "projects" || !parts[1]) return { kind: "unknown" };

  const projectRef = parts[1];
  const sectionPath = parts.slice(2);
  if (!sectionPath.length) {
    return { kind: "project", projectRef, page: "dashboard" };
  }

  // Compatibility with the former /custom/:sectionId route.
  if (sectionPath[0] === "custom" && sectionPath[1]) {
    const oldSection = sections.find(
      (section) =>
        section.id === sectionPath[1] ||
        sectionSegment(section, sections) === sectionPath[1],
    );
    if (oldSection) {
      return {
        kind: "project",
        projectRef,
        page: customSectionKey(oldSection.id),
      };
    }
  }

  const customSection = findSectionBySegments(sectionPath, sections);
  if (customSection) {
    return {
      kind: "project",
      projectRef,
      page: customSectionKey(customSection.id),
    };
  }

  const standardPage = segmentPages.get(sectionPath[0]);
  if (standardPage && sectionPath.length === 1) {
    return { kind: "project", projectRef, page: standardPage };
  }
  return {
    kind: "project",
    projectRef,
    page: standardPage ?? "dashboard",
    unresolvedSectionPath: sectionPath.length > 1,
  };
}

export function pagePath(
  projectSlug: string,
  page: PageKey,
  sections: CustomSectionDefinition[] = [],
): string {
  if (page === "settings") return "/settings";
  if (page === "subscription") return "/settings/subscription";
  if (page.startsWith("custom:")) {
    const sectionId = page.slice("custom:".length);
    const section = sections.find((item) => item.id === sectionId);
    const segments = section
      ? customSectionSegments(section, sections)
      : ["custom", sectionId];
    return `/projects/${encodeURIComponent(projectSlug)}/${segments
      .map(encodeURIComponent)
      .join("/")}`;
  }
  const segment = pageSegments[page] ?? "dashboard";
  return `/projects/${encodeURIComponent(projectSlug)}/${segment}`;
}

export function projectDashboardPath(projectSlug: string): string {
  return pagePath(projectSlug, "dashboard");
}
