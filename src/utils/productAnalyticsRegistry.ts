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
  "notes",
  "custom_section",
  "unknown",
] as const;

export type ProductAnalyticsPageCode = typeof PRODUCT_ANALYTICS_PAGE_CODES[number];

export const PRODUCT_ANALYTICS_ACTION_CODES = [
  "project_open",
  "project_create",
  "person_create",
  "person_edit",
  "person_delete",
  "tree_open",
  "tree_mode_change",
  "tree_branch_expand",
  "tree_search",
  "ancestor_chart_build",
  "ancestor_chart_export",
  "tree_statistics_open",
  "tree_statistics_export",
  "gedcom_import_start",
  "gedcom_import_complete",
  "gedcom_import_fail",
  "gedcom_export_start",
  "gedcom_export_complete",
  "gedcom_export_fail",
  "document_create",
  "document_viewer_open",
  "document_first_page_render",
  "document_page_export",
  "finding_create_from_document",
  "search_use",
  "filter_apply",
  "table_export",
  "ai_hypothesis_check",
  "ai_document_recognition",
  "feedback_create",
  "subscription_page_open",
] as const;

export type ProductAnalyticsActionCode = typeof PRODUCT_ANALYTICS_ACTION_CODES[number];

export const PRODUCT_ANALYTICS_ACTION_LABELS: Record<ProductAnalyticsActionCode, string> = {
  project_open: "Відкриття проєкту",
  project_create: "Створення проєкту",
  person_create: "Створення особи",
  person_edit: "Редагування особи",
  person_delete: "Видалення особи",
  tree_open: "Відкриття дерева",
  tree_mode_change: "Зміна режиму дерева",
  tree_branch_expand: "Розгортання гілки дерева",
  tree_search: "Пошук у дереві",
  ancestor_chart_build: "Побудова діаграми предків",
  ancestor_chart_export: "Експорт діаграми предків",
  tree_statistics_open: "Відкриття статистики дерева",
  tree_statistics_export: "Експорт статистики дерева",
  gedcom_import_start: "Початок імпорту GEDCOM",
  gedcom_import_complete: "Успішний імпорт GEDCOM",
  gedcom_import_fail: "Помилка імпорту GEDCOM",
  gedcom_export_start: "Початок експорту GEDCOM",
  gedcom_export_complete: "Успішний експорт GEDCOM",
  gedcom_export_fail: "Помилка експорту GEDCOM",
  document_create: "Створення документа",
  document_viewer_open: "Відкриття переглядача документа",
  document_first_page_render: "Перша сторінка документа показана",
  document_page_export: "Експорт сторінки документа",
  finding_create_from_document: "Знахідка з документа",
  search_use: "Використання пошуку",
  filter_apply: "Застосування фільтра",
  table_export: "Експорт таблиці",
  ai_hypothesis_check: "Перевірка гіпотези ШІ",
  ai_document_recognition: "Розпізнавання документа ШІ",
  feedback_create: "Створення звернення",
  subscription_page_open: "Відкриття тарифів",
};

export const PRODUCT_ANALYTICS_PAGE_ACTIONS: Partial<
  Record<ProductAnalyticsPageCode, ProductAnalyticsActionCode>
> = {
  dashboard: "project_open",
  family_tree: "tree_open",
  family_tree_pedigree: "tree_open",
  tree_statistics: "tree_statistics_open",
  document_viewer: "document_viewer_open",
  subscription: "subscription_page_open",
};

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
  feedback: "Підтримка Трекера Роду",
  notes: "Нотатки",
  custom_section: "Власний розділ",
  unknown: "Інша сторінка",
};

export function productAnalyticsPageCode(route: AppRoute): ProductAnalyticsPageCode {
  if (route.kind === "projects") return "projects";
  if (route.kind === "notes") return "notes";
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
