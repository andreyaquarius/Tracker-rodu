import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { appAppearanceKey, appearanceStorage, DEFAULT_APP_APPEARANCE, parseAppAppearance, readAppAppearance, writeAppAppearance, type AppAppearance, type AppTheme } from "../../utils/appAppearance.ts";
import { StarrySkyCanvas } from "./StarrySkyCanvas.tsx";
import "./appAppearance.css";

interface AppearanceContext {
  appearance: AppAppearance;
  persisted: boolean;
  setTheme: (theme: AppTheme) => void;
  setSkyMotion: (enabled: boolean) => void;
  setAccountScope: (accountId: string | null) => void;
}
const Context = createContext<AppearanceContext>({ appearance: DEFAULT_APP_APPEARANCE, persisted: true,
  setTheme: () => {}, setSkyMotion: () => {}, setAccountScope: () => {} });
export const useAppAppearance = () => useContext(Context);

/** The existing auth flow supplies only an ID. No second auth client or token-refresh listener. */
export function useAppAppearanceAccount(accountId: string | null, ready: boolean) {
  const { setAccountScope } = useAppAppearance();
  useLayoutEffect(() => { if (ready) setAccountScope(accountId); }, [accountId, ready, setAccountScope]);
}

function AppSky({ moving }: { moving: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const node = host.current; if (!node) return;
    const resize = () => {
      const { width, height } = node.getBoundingClientRect();
      setSize(current => current.width === width && current.height === height ? current : { width, height });
    };
    resize(); const observer = new ResizeObserver(resize); observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <div ref={host} className="app-starry-sky" aria-hidden="true">
    <StarrySkyCanvas {...size} moving={moving} />
  </div>;
}

export function AppAppearanceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(() => ({ accountId: null as string | null, appearance: readAppAppearance(null), persisted: true }));
  const current = useRef(state);
  const commit = useCallback((next: typeof state) => { current.current = next; setState(next); }, []);
  const setAccountScope = useCallback((accountId: string | null) => {
    if (current.current.accountId === accountId) return;
    commit({ accountId, appearance: readAppAppearance(accountId), persisted: true });
  }, [commit]);
  const change = useCallback((patch: Partial<AppAppearance>) => {
    const { accountId, appearance } = current.current;
    const next = { ...appearance, ...patch };
    commit({ accountId, appearance: next, persisted: writeAppAppearance(accountId, next) });
  }, [commit]);
  const setTheme = useCallback((theme: AppTheme) => change({ theme }), [change]);
  const setSkyMotion = useCallback((skyMotion: boolean) => change({ skyMotion }), [change]);
  useLayoutEffect(() => {
    document.documentElement.dataset.appTheme = state.appearance.theme;
  }, [state.appearance.theme]);
  useEffect(() => () => { delete document.documentElement.dataset.appTheme; }, []);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.storageArea !== appearanceStorage()) return;
      if (event.key !== null && event.key !== appAppearanceKey(current.current.accountId)) return;
      commit({ ...current.current, appearance: parseAppAppearance(event.newValue), persisted: true });
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [commit]);
  const value = useMemo(() => ({ appearance: state.appearance, persisted: state.persisted, setTheme, setSkyMotion, setAccountScope }),
    [state.appearance, state.persisted, setTheme, setSkyMotion, setAccountScope]);
  // No keyed wrapper, navigation, reload, project save, or form remount on appearance changes.
  return <Context.Provider value={value}>
    {state.appearance.theme === "starry-dark" ? <AppSky moving={state.appearance.skyMotion} /> : null}
    {children}
  </Context.Provider>;
}
