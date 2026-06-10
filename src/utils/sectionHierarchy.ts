import type {
  CustomFieldModule,
  CustomSectionDefinition,
  SectionParentKey,
} from "../types";

export const hierarchyRootKeys: CustomFieldModule[] = [
  "researches",
  "documents",
  "archiveRequests",
  "yearMatrix",
  "tasks",
  "findings",
  "hypotheses",
  "persons",
];

export const hierarchyRootLabels: Record<CustomFieldModule, string> = {
  researches: "Дослідження",
  documents: "Документи",
  archiveRequests: "Запити в архів",
  yearMatrix: "Матриця років",
  tasks: "Завдання",
  findings: "Знахідки",
  hypotheses: "Гіпотези",
  persons: "Особи",
};

export function customSectionKey(sectionId: string): `custom:${string}` {
  return `custom:${sectionId}`;
}

export function childSections(
  sections: CustomSectionDefinition[],
  parentKey: SectionParentKey | null,
): CustomSectionDefinition[] {
  return sections.filter((section) => section.parentKey === parentKey);
}

export function sectionAncestors(
  sections: CustomSectionDefinition[],
  section: CustomSectionDefinition,
): Array<{ key: SectionParentKey; label: string }> {
  const result: Array<{ key: SectionParentKey; label: string }> = [];
  const seen = new Set<string>();
  let parentKey = section.parentKey;

  while (parentKey && !seen.has(parentKey)) {
    seen.add(parentKey);
    if (!parentKey.startsWith("custom:")) {
      const rootKey = parentKey as CustomFieldModule;
      result.unshift({
        key: rootKey,
        label: hierarchyRootLabels[rootKey],
      });
      break;
    }
    const parent = sections.find(
      (candidate) => customSectionKey(candidate.id) === parentKey,
    );
    if (!parent) break;
    result.unshift({ key: parentKey, label: parent.name });
    parentKey = parent.parentKey;
  }

  return result;
}

export function sectionDescendantIds(
  sections: CustomSectionDefinition[],
  sectionId: string,
): Set<string> {
  const result = new Set<string>();
  const queue = [customSectionKey(sectionId) as SectionParentKey];
  while (queue.length) {
    const parentKey = queue.shift()!;
    for (const child of childSections(sections, parentKey)) {
      if (result.has(child.id)) continue;
      result.add(child.id);
      queue.push(customSectionKey(child.id));
    }
  }
  return result;
}

export function sectionDepth(
  sections: CustomSectionDefinition[],
  section: CustomSectionDefinition,
): number {
  return sectionAncestors(sections, section).length;
}

export function isHierarchyPage(page: string): page is SectionParentKey {
  return hierarchyRootKeys.includes(page as CustomFieldModule) ||
    page.startsWith("custom:");
}
