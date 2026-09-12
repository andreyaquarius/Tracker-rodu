import type { PageKey } from "./Sidebar";
import { helpGuideKeyForPage, type HelpGuideKey } from "../help/helpGuides.ts";
import { SectionHelp } from "../help/ContextHelp.tsx";

export function HelpCenter({ page, guideKey, accountId: _accountId }: { page: PageKey | null; guideKey?: HelpGuideKey; accountId: string }) {
  // Reuse the existing top-bar slot; no extra instruction row above the page.
  return <SectionHelp guideKey={guideKey ?? helpGuideKeyForPage(page)} automatic={guideKey !== "tree-statistics" && (!page || !["persons", "places"].includes(page))} />;
}
