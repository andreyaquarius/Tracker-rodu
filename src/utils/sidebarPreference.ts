export const SIDEBAR_COLLAPSED_STORAGE_KEY = "tracker-rodu.sidebar-collapsed.v1";
export const DESKTOP_SIDEBAR_WIDTH = 340;
export const SIDEBAR_LAYOUT_CHANGE_EVENT = "tracker-sidebar-layout-change";

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem">;

export function readSidebarCollapsed(storage?: ReadableStorage | null): boolean {
  if (!storage) return false;

  try {
    return storage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(
  storage: WritableStorage | null | undefined,
  collapsed: boolean,
): void {
  if (!storage) return;

  try {
    storage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // Storage may be disabled or full. The in-memory UI state still works.
  }
}

export function browserLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
