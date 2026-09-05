import { useId } from "react";
import { useSkyMotionEnvironment } from "../../features/family-tree-view/appearance/useSkyMotionEnvironment.ts";
import { useAppAppearance } from "./AppAppearanceProvider.tsx";

export function AppAppearanceSettings({ compact = false }: { compact?: boolean }) {
  const { appearance, setTheme, setSkyMotion, persisted } = useAppAppearance();
  const { reducedMotion } = useSkyMotionEnvironment();
  const groupId = useId();
  return <section className={compact ? "app-appearance-compact" : "panel app-appearance-settings"} aria-label="Тема застосунку">
    {compact ? <strong>Тема застосунку</strong> : <div className="section-heading"><div>
      <h2>Тема застосунку</h2>
      <p>Особисте оформлення всіх розділів. Зберігається для вашого облікового запису в цьому браузері й не змінює налаштувань інших учасників.</p>
    </div></div>}
    <div className="app-theme-options" role="group" aria-label="Оформлення застосунку">
      {([{ value: "standard", title: "Стандартна", detail: "Теплий папір і зелені акценти" },
        { value: "starry-dark", title: "Темна із зоряним небом", detail: "Нічна палітра та м’яке світло зірок" }] as const).map(option => <label
        key={option.value} className="app-theme-option" data-selected={appearance.theme === option.value}>
        {!compact ? <span className={`app-theme-sample app-theme-sample-${option.value}`} aria-hidden="true"><i /><i /><i /></span> : null}
        <span className="app-theme-option-heading"><input type="radio" name={groupId} value={option.value} aria-label={option.title}
          checked={appearance.theme === option.value} onChange={() => setTheme(option.value)} /><strong>{option.title}</strong></span>
        {!compact ? <small>{option.detail}</small> : null}
      </label>)}
    </div>
    {appearance.theme === "starry-dark" ? <label className="setting-toggle app-sky-motion">
      <div><strong>Рух зоряного неба</strong><span>{reducedMotion
        ? "Рух вимкнено системним налаштуванням зменшення анімації."
        : "Плавний рух зірок і поодинокі комети. Можна залишити небо нерухомим."}</span></div>
      <input type="checkbox" checked={appearance.skyMotion && !reducedMotion} disabled={reducedMotion}
        onChange={event => setSkyMotion(event.target.checked)} />
    </label> : null}
    {!persisted ? <p className="app-appearance-warning" role="status">Браузер не дозволив зберегти вибір. Тема діятиме до закриття цієї вкладки.</p> : null}
  </section>;
}
