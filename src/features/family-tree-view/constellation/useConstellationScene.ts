import { useEffect, useState } from "react";
import type { FamilyGraphData } from "../types.ts";
import { buildConstellationScene, type ConstellationScene } from "./constellationModel.ts";

export function useConstellationScene(graph: FamilyGraphData, focusId: string) {
  const [result, setResult] = useState<{ graph: FamilyGraphData; focusId: string; scene?: ConstellationScene; error?: string }>();
  useEffect(() => {
    let disposed = false;
    let worker: Worker | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const calculateFallback = () => {
      worker?.terminate();
      if (disposed || fallback !== undefined) return;
      fallback = setTimeout(() => {
        if (disposed) return;
        try { setResult({ graph, focusId, scene: buildConstellationScene(graph, focusId) }); }
        catch { setResult({ graph, focusId, error: "Не вдалося побудувати сузір’я. Спробуйте зменшити кількість поколінь." }); }
      }, 0);
    };
    try {
      worker = new Worker(new URL("./constellationLayout.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<{ scene?: ConstellationScene; error?: string }>) => {
        if (disposed) return;
        if (!event.data.scene) { calculateFallback(); return; }
        setResult({ graph, focusId, scene: event.data.scene });
        worker?.terminate();
      };
      worker.onerror = calculateFallback;
      worker.onmessageerror = calculateFallback;
      worker.postMessage({ graph, focusId });
    } catch { calculateFallback(); }
    return () => { disposed = true; worker?.terminate(); clearTimeout(fallback); };
  }, [graph, focusId]);
  return result?.graph === graph && result.focusId === focusId
    ? { scene: result.scene, error: result.error, loading: false }
    : { scene: undefined, error: undefined, loading: true };
}
