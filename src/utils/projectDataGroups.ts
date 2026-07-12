import type { PageKey } from "../components/Sidebar";

export type ProjectDataGroup =
  | "researches"
  | "people"
  | "documents"
  | "work"
  | "analysis";

export const ALL_PROJECT_DATA_GROUPS: ProjectDataGroup[] = [
  "researches",
  "people",
  "documents",
  "work",
  "analysis",
];

export function dataGroupsForPage(page: PageKey): Set<ProjectDataGroup> {
  if (page === "map") return new Set(["researches", "people", "documents", "work"]);
  if (page === "familyTree") return new Set(["people"]);
  if (page === "researches") return new Set(["researches"]);
  if (page === "documents") return new Set(["researches", "documents"]);
  if (page === "archiveRequests") {
    return new Set(["researches", "people", "analysis"]);
  }
  if (page === "yearMatrix") {
    return new Set(["researches", "documents", "work"]);
  }
  if (page === "tasks" || page === "findings") {
    return new Set(["researches", "people", "documents", "work"]);
  }
  if (page === "persons") {
    // Render the list first. Person-card supporting groups are requested in the
    // background by App after the people collection has hydrated.
    return new Set(["researches", "people"]);
  }
  if (page === "hypotheses" || page === "backup") {
    return new Set(ALL_PROJECT_DATA_GROUPS);
  }
  if (page.startsWith("custom:")) {
    return new Set(ALL_PROJECT_DATA_GROUPS);
  }
  return new Set();
}
