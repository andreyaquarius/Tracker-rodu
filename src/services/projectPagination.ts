export const PROJECT_PAGE_SIZE = 50;

export interface ProjectPage<T> {
  items: T[];
  hasMore: boolean;
}

export function pageRange(page: number): { from: number; to: number } {
  const from = Math.max(0, page) * PROJECT_PAGE_SIZE;
  return { from, to: from + PROJECT_PAGE_SIZE - 1 };
}

export function asProjectPage<T>(items: T[]): ProjectPage<T> {
  return {
    items,
    hasMore: items.length === PROJECT_PAGE_SIZE,
  };
}
