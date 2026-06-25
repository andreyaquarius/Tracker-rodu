import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export interface WorkspaceWindowControls {
  stackIndex: number;
  dockIndex: number;
  onFocus: () => void;
  close: () => void;
}

interface WorkspaceWindowEntry {
  id: string;
  ownerKey: string;
  logicalKey: string;
  minimized: boolean;
  minimizedOrder: number | null;
  render: (controls: WorkspaceWindowControls) => ReactNode;
}

interface WorkspaceWindowInput {
  id?: string;
  ownerKey: string;
  logicalKey: string;
  render: (controls: WorkspaceWindowControls) => ReactNode;
}

interface WorkspaceWindowsContextValue {
  openWindow: (window: WorkspaceWindowInput) => void;
  closeWindow: (windowId: string) => void;
  closeWindows: (predicate: (window: Pick<WorkspaceWindowEntry, "ownerKey" | "logicalKey">) => boolean) => void;
  focusWindow: (windowId: string) => void;
  setWindowMinimized: (windowId: string, minimized: boolean) => void;
}

interface WorkspaceWindowFrameContextValue {
  stackIndex: number;
  dockIndex: number;
  minimized: boolean;
  setMinimized: (minimized: boolean) => void;
  onFocus: () => void;
  close: () => void;
}

const WorkspaceWindowsContext = createContext<WorkspaceWindowsContextValue | null>(null);
const WorkspaceWindowFrameContext = createContext<WorkspaceWindowFrameContextValue | null>(null);

export function WorkspaceWindowsProvider({
  scopeKey,
  children,
}: {
  scopeKey: string;
  children: ReactNode;
}) {
  const [windows, setWindows] = useState<WorkspaceWindowEntry[]>([]);
  const minimizedOrderRef = useRef(0);

  useEffect(() => {
    minimizedOrderRef.current = 0;
    setWindows([]);
  }, [scopeKey]);

  const value = useMemo<WorkspaceWindowsContextValue>(() => ({
    openWindow: (window) => {
      setWindows((current) => {
        const next: WorkspaceWindowEntry = {
          ...window,
          id: window.id ?? createWindowId(),
          minimized: false,
          minimizedOrder: null,
        };
        return [
          ...current.filter((item) =>
            item.ownerKey !== window.ownerKey || item.logicalKey !== window.logicalKey,
          ),
          next,
        ];
      });
    },
    closeWindow: (windowId) => {
      setWindows((current) => current.filter((window) => window.id !== windowId));
    },
    closeWindows: (predicate) => {
      setWindows((current) => current.filter((window) => !predicate(window)));
    },
    focusWindow: (windowId) => {
      setWindows((current) => {
        const target = current.find((window) => window.id === windowId);
        if (!target || current[current.length - 1]?.id === windowId) return current;
        return [...current.filter((window) => window.id !== windowId), target];
      });
    },
    setWindowMinimized: (windowId, minimized) => {
      setWindows((current) => current.map((window) => {
        if (window.id !== windowId) return window;
        if (!minimized) {
          return { ...window, minimized: false, minimizedOrder: null };
        }
        if (window.minimized) return window;
        minimizedOrderRef.current += 1;
        return {
          ...window,
          minimized: true,
          minimizedOrder: minimizedOrderRef.current,
        };
      }));
    },
  }), []);

  return (
    <WorkspaceWindowsContext.Provider value={value}>
      {children}
      <WorkspaceWindowLayer windows={windows} actions={value} />
    </WorkspaceWindowsContext.Provider>
  );
}

export function useWorkspaceWindows(): WorkspaceWindowsContextValue {
  const context = useContext(WorkspaceWindowsContext);
  if (!context) {
    throw new Error("useWorkspaceWindows must be used inside WorkspaceWindowsProvider");
  }
  return context;
}

export function useWorkspaceWindowFrame(): WorkspaceWindowFrameContextValue | null {
  return useContext(WorkspaceWindowFrameContext);
}

function WorkspaceWindowLayer({
  windows,
  actions,
}: {
  windows: WorkspaceWindowEntry[];
  actions: WorkspaceWindowsContextValue;
}) {
  const dockIndexes = new Map(
    windows
      .filter((window) => window.minimized)
      .sort((left, right) => (left.minimizedOrder ?? 0) - (right.minimizedOrder ?? 0))
      .map((window, index) => [window.id, index]),
  );

  return (
    <>
      {windows.map((window, index) => (
        <WindowRenderHost
          key={window.id}
          window={window}
          index={index}
          dockIndex={dockIndexes.get(window.id) ?? index}
          actions={actions}
        />
      ))}
    </>
  );
}

function WindowRenderHost({
  window,
  index,
  dockIndex,
  actions,
}: {
  window: WorkspaceWindowEntry;
  index: number;
  dockIndex: number;
  actions: WorkspaceWindowsContextValue;
}) {
  const controls: WorkspaceWindowControls = {
    stackIndex: index,
    dockIndex,
    onFocus: () => actions.focusWindow(window.id),
    close: () => actions.closeWindow(window.id),
  };

  return (
    <WorkspaceWindowFrameContext.Provider
      value={{
        ...controls,
        minimized: window.minimized,
        setMinimized: (minimized) => actions.setWindowMinimized(window.id, minimized),
      }}
    >
      {window.render(controls)}
    </WorkspaceWindowFrameContext.Provider>
  );
}

function createWindowId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `window-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
