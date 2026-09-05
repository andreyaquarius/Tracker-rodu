import { useEffect, useState } from "react";

export function useSkyMotionEnvironment() {
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const reduced = () => setReducedMotion(media.matches);
    const visibility = () => setVisible(!document.hidden);
    media.addEventListener("change", reduced); document.addEventListener("visibilitychange", visibility);
    return () => { media.removeEventListener("change", reduced); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  return { reducedMotion, visible };
}
