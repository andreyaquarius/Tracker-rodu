import { useSkyMotionEnvironment } from "../../features/family-tree-view/appearance/useSkyMotionEnvironment.ts";
import { useAppAppearance } from "../appearance/AppAppearanceProvider.tsx";

export function StarryBackgroundToggle({ enabled, onChange }: {
  enabled: boolean; onChange: (enabled: boolean) => void;
}) {
  const globalSky = useAppAppearance().appearance.theme === "starry-dark";
  return <button type="button" className="tree-starry-toggle" aria-pressed={enabled || globalSky} disabled={globalSky}
    title={globalSky ? "Увімкнено загальною темою. Змінити її можна в меню профілю або Налаштуваннях." : enabled ? "Повернути звичайне тло" : "Зоряне небо та підсвічування карток і секторів"}
    onClick={() => onChange(!enabled)}>
    <span aria-hidden="true">✧</span> Зоряне небо
  </button>;
}

export function StarryAnimationToggle({ enabled, skyEnabled, onChange }: {
  enabled: boolean; skyEnabled: boolean; onChange: (enabled: boolean) => void;
}) {
  const { reducedMotion } = useSkyMotionEnvironment();
  const { appearance } = useAppAppearance();
  const globalSky = appearance.theme === "starry-dark";
  const globalPause = globalSky && !appearance.skyMotion;
  return <button type="button" className="tree-starry-toggle" aria-pressed={enabled && (skyEnabled || globalSky) && !reducedMotion && !globalPause}
    disabled={(!skyEnabled && !globalSky) || reducedMotion || globalPause}
    title={globalPause ? "Рух неба вимкнено для всього застосунку в налаштуваннях теми" : reducedMotion ? "У системі ввімкнено зменшення руху — небо нерухоме" : "Увімкнути або вимкнути рух зірок і рідкісні прольоти комет"}
    onClick={() => onChange(!enabled)}>
    <span aria-hidden="true">{enabled && (skyEnabled || globalSky) && !reducedMotion && !globalPause ? "Ⅱ" : "▷"}</span> Рух неба
  </button>;
}
