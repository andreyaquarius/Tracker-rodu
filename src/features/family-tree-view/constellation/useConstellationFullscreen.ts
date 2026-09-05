import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** Fullscreen owns the whole dialog, including its header, menus and details. */
export function useConstellationFullscreen(contentRef: RefObject<HTMLDivElement | null>, onBrowserExit: () => void) {
  const [mode, setMode] = useState<"window" | "native" | "fallback">("window");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const targetRef = useRef<HTMLElement | null>(null);
  const alive = useRef(false);
  const wanted = useRef(false);
  const ownedNative = useRef(false);
  const entering = useRef<Promise<void> | null>(null);
  const leaving = useRef<Promise<boolean> | null>(null);
  const onBrowserExitRef = useRef(onBrowserExit);
  onBrowserExitRef.current = onBrowserExit;

  useEffect(() => {
    alive.current = true;
    const target = contentRef.current?.closest<HTMLElement>(".constellation-modal") ?? null;
    targetRef.current = target;
    const sync = () => {
      const own = Boolean(target && document.fullscreenElement === target);
      if (own) {
        ownedNative.current = true;
        if (wanted.current) { setMode("native"); setMessage(""); }
      } else if (ownedNative.current) {
        ownedNative.current = false;
        wanted.current = false;
        setMode("window"); setMessage("");
        // Escape and browser UI can exit without delivering a keyboard event.
        if (!leaving.current) onBrowserExitRef.current();
      }
    };
    document.addEventListener("fullscreenchange", sync);
    return () => {
      alive.current = false;
      wanted.current = false;
      document.removeEventListener("fullscreenchange", sync);
      if (target && document.fullscreenElement === target) {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, [contentRef]);

  const enter = useCallback((): Promise<void> => {
    if (entering.current) return entering.current;
    if (wanted.current || leaving.current) return Promise.resolve();
    const target = targetRef.current;
    if (!target?.isConnected || !alive.current) return Promise.resolve();
    wanted.current = true;
    setMode("fallback"); setMessage(""); setPending(true);
    // Call requestFullscreen in the click handler's activation, not a later effect.
    const operation = (async () => {
      try {
        if (!target.requestFullscreen || document.fullscreenEnabled === false) {
          setMessage("Цей браузер не підтримує повний екран для мапи. Вікно розгорнуто на всю вкладку.");
          return;
        }
        await target.requestFullscreen({ navigationUI: "hide" });
        if (!alive.current || !wanted.current || !target.isConnected) {
          if (document.fullscreenElement === target) await document.exitFullscreen().catch(() => undefined);
          return;
        }
        if (document.fullscreenElement === target) {
          ownedNative.current = true;
          setMode("native"); setMessage("");
        }
      } catch {
        if (alive.current && wanted.current) {
          setMessage("Браузер не дозволив повний екран. Вікно розгорнуто на всю вкладку; можна вийти кнопкою або Esc.");
        }
      } finally {
        if (alive.current) setPending(false);
      }
    })();
    entering.current = operation;
    void operation.then(() => { if (entering.current === operation) entering.current = null; });
    return operation;
  }, []);

  const exit = useCallback((): Promise<boolean> => {
    if (leaving.current) return leaving.current;
    wanted.current = false;
    if (alive.current) { setMessage(""); setPending(true); }
    const operation = (async () => {
      try {
        // A close during an outstanding request must not leave fullscreen behind.
        await entering.current;
        const target = targetRef.current;
        if (target && document.fullscreenElement === target) await document.exitFullscreen();
        ownedNative.current = false;
        if (alive.current) setMode("window");
        return true;
      } catch {
        if (alive.current) {
          wanted.current = true;
          setMessage("Не вдалося вийти з повного екрана. Натисніть Esc або скористайтеся керуванням браузера.");
        }
        return false;
      } finally {
        if (alive.current) setPending(false);
      }
    })();
    leaving.current = operation;
    void operation.then(() => { if (leaving.current === operation) leaving.current = null; });
    return operation;
  }, []);

  return { active: mode !== "window", native: mode === "native", pending, message, enter, exit };
}
