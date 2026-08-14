import type { AppRoute } from "./appRoutes.ts";

export const PRODUCT_ANALYTICS_PAGE_CODES = [
  "projects",
  "dashboard",
  "map",
  "persons_list",
  "person_profile",
  "person_edit",
  "family_tree",
  "family_tree_pedigree",
  "ancestor_wheel",
  "tree_statistics",
  "researches",
  "documents",
  "document_viewer",
  "requests",
  "year_matrix",
  "tasks",
  "findings",
  "hypotheses",
  "backup",
  "settings",
  "subscription",
  "feedback",
  "custom_section",
  "unknown",
] as const;

export type ProductAnalyticsPageCode = typeof PRODUCT_ANALYTICS_PAGE_CODES[number];

export const PRODUCT_ANALYTICS_PAGE_LABELS: Record<ProductAnalyticsPageCode, string> = {
  projects: "Проєкти",
  dashboard: "Панель проєкту",
  map: "Карта",
  persons_list: "Особи — список",
  person_profile: "Картка особи",
  person_edit: "Редагування особи",
  family_tree: "Родове дерево",
  family_tree_pedigree: "Родовід прямих предків",
  ancestor_wheel: "Кругова діаграма предків",
  tree_statistics: "Статистика дерева",
  researches: "Дослідження",
  documents: "Документи",
  document_viewer: "Переглядач документів",
  requests: "Запити",
  year_matrix: "Матриця років",
  tasks: "Завдання",
  findings: "Знахідки",
  hypotheses: "Гіпотези",
  backup: "Резервні копії",
  settings: "Налаштування",
  subscription: "Тариф і підписка",
  feedback: "Зворотний зв’язок",
  custom_section: "Власний розділ",
  unknown: "Інша сторінка",
};

export function productAnalyticsPageCode(route: AppRoute): ProductAnalyticsPageCode {
  if (route.kind === "projects") return "projects";
  if (route.kind === "settings") {
    if (route.page === "subscription") return "subscription";
    if (route.page === "feedback") return "feedback";
    return "settings";
  }
  if (route.kind !== "project") return "unknown";
  if (route.page.startsWith("custom:")) return "custom_section";
  if (route.page === "persons") {
    if (route.personMode === "edit" || route.personMode === "new") return "person_edit";
    if (route.personId || route.personMode === "profile") return "person_profile";
    return "persons_list";
  }
  if (route.page === "familyTree") {
    return route.familyTreeView === "statistics" ? "tree_statistics" : "family_tree";
  }
  const pageMap = {
    dashboard: "dashboard",
    map: "map",
    researches: "researches",
    documents: "documents",
    archiveRequests: "requests",
    yearMatrix: "year_matrix",
    tasks: "tasks",
    findings: "findings",
    hypotheses: "hypotheses",
    backup: "backup",
    settings: "settings",
    subscription: "subscription",
    feedback: "feedback",
  } as const;
  return pageMap[route.page as keyof typeof pageMap] ?? "unknown";
}
