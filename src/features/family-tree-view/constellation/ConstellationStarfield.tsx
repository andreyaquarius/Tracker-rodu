import { StarrySkyCanvas } from "../../../components/appearance/StarrySkyCanvas.tsx";
import type { ConstellationTheme } from "./constellationCinema.ts";
import { useAppAppearance } from "../../../components/appearance/AppAppearanceProvider.tsx";
export { useSkyMotionEnvironment as useConstellationMotionEnvironment } from "../appearance/useSkyMotionEnvironment.ts";

/** Keep the capture/export selector stable while sharing the screen-space sky. */
export function ConstellationStarfield(props: {
  width: number; height: number; theme: ConstellationTheme; enabled: boolean; moving: boolean;
}) {
  const { appearance } = useAppAppearance();
  return <StarrySkyCanvas {...props} moving={props.moving && (appearance.theme !== "starry-dark" || appearance.skyMotion)} className="constellation-starfield" />;
}
