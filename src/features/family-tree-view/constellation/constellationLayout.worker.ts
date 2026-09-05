import { buildConstellationScene } from "./constellationModel.ts";
import type { FamilyGraphData } from "../types.ts";

globalThis.onmessage = (event: MessageEvent<{ graph: FamilyGraphData; focusId: string }>) => {
  try {
    globalThis.postMessage({ scene: buildConstellationScene(event.data.graph, event.data.focusId) });
  } catch (error) {
    globalThis.postMessage({ error: error instanceof Error ? error.message : "Не вдалося побудувати сузір’я." });
  }
};
