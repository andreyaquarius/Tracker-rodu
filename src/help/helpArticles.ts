import { helpGuides, fullHelpTourKeys, type HelpGuideKey, type HelpStep } from "./helpGuides.ts";
import { helpTopics } from "./helpManualContent.ts";

export interface HelpArticle { key: string; parent: HelpGuideKey; title: string; intro: string; steps: HelpStep[]; warning?: string }
export const helpArticles: readonly HelpArticle[] = [
  ...fullHelpTourKeys.map((key) => ({ ...helpGuides[key], parent: key })), ...helpTopics,
];
const byKey = new Map(helpArticles.map((article) => [article.key, article]));
export function helpArticleFor(key: HelpGuideKey, topic?: string): HelpArticle {
  return byKey.get(topic ? `${key}:${topic}` : key) ?? byKey.get(key) ?? byKey.get("workspace-intro")!;
}
export function searchHelpArticles(query: string): HelpArticle[] {
  const tokens = query.trim().toLocaleLowerCase("uk-UA").split(/\s+/u).filter(Boolean);
  return helpArticles.filter((article) => {
    const text = [article.title, article.intro, article.warning, ...article.steps.flatMap((step) => [step.title, step.text])].join(" ").toLocaleLowerCase("uk-UA");
    return tokens.every((token) => text.includes(token));
  });
}
export const HELP_CONTEXT_PROGRESS_KEY = "tracker-rodu-help-context-progress-v1";
export function parseHelpContextProgress(raw: string | null): Record<string, true> {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([key, seen]) => byKey.has(key) && seen === true));
  } catch { return {}; }
}
