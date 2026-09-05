import { useEffect, useRef } from "react";
import { Modal } from "../Modal";
import { StarryAnimationToggle, StarryBackgroundToggle } from "./StarryBackgroundToggle";
import type { FamilyTreeAppearancePreferences } from "../../utils/familyTreeAppearance";
import type { FamilyTreeAppearanceSyncState } from "../../hooks/useFamilyTreeAppearancePreferences";

export type FamilyTreeDisplayMode = "classic" | "direct-ancestors";

interface FamilyTreeDisplayWindowProps {
  treeTitle: string;
  displayMode: FamilyTreeDisplayMode;
  appearance: FamilyTreeAppearancePreferences;
  onAppearanceChange: (appearance: FamilyTreeAppearancePreferences) => void;
  appearanceSyncState?: FamilyTreeAppearanceSyncState;
  onSelectDisplayMode: (mode: FamilyTreeDisplayMode) => void;
  onOpenConstellationChart: () => void;
  onOpenCircularChart: () => void;
  onOpenAncestorFanChart: () => void;
  onOpenDescendantFanChart: () => void;
  onClose: () => void;
}

export function FamilyTreeDisplayWindow({
  treeTitle,
  displayMode,
  appearance,
  onAppearanceChange,
  appearanceSyncState = "idle",
  onSelectDisplayMode,
  onOpenConstellationChart,
  onOpenCircularChart,
  onOpenAncestorFanChart,
  onOpenDescendantFanChart,
  onClose,
}: FamilyTreeDisplayWindowProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const trigger = document.activeElement;
    const dialog = bodyRef.current?.closest('[role="dialog"]');
    bodyRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && dialog?.contains(document.activeElement)) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  return (
    <Modal title="Відображення дерева" mode="window" minimizable={false} onClose={onClose}>
      <div ref={bodyRef} className="family-tree-tools-window">
        <div className="family-tree-tools-summary">
          <span className="eyebrow">Активне дерево</span>
          <strong>{treeTitle || "Родове дерево"}</strong>
          <small>Оберіть класичне дерево, сузір’я родинних зв’язків або діаграму предків чи нащадків.</small>
        </div>
        <div className="family-tree-sky-setting">
          <div>
            <strong>Оформлення полотна</strong>
            <small>Зоряне тло з підсвічуванням карток і секторів у класичному дереві, родоводі прямих предків та діаграмах. Вибір зберігається особисто для вас у цьому дереві. У «Сузір’ї роду» — власне оформлення.</small>
            <small>«Рух неба» додає плавний дрейф зірок і рідкісні прольоти комет. Анімація не змінює положення карток; її можна вимкнути окремо від тла. Загальна темна тема вмикає небо в усіх деревах; змінити її можна в меню профілю або в Налаштуваннях.</small>
            {appearanceSyncState !== "idle" ? <small role="status">{{
              loading: "Завантажуємо ваші налаштування…",
              saving: "Зберігаємо налаштування…",
              saved: "Збережено в обліковому записі.",
              error: "Вибір збережено лише в цьому браузері. Синхронізація з обліковим записом зараз недоступна.",
            }[appearanceSyncState]}</small> : null}
          </div>
          <StarryBackgroundToggle enabled={appearance.starryBackground}
            onChange={starryBackground => onAppearanceChange({ ...appearance, starryBackground })} />
          <StarryAnimationToggle enabled={appearance.starryAnimation} skyEnabled={appearance.starryBackground}
            onChange={starryAnimation => onAppearanceChange({ ...appearance, starryAnimation })} />
        </div>
        <div className="family-tree-tools-grid" role="group" aria-label="Способи відображення дерева">
          <button
            type="button"
            className={`family-tree-tools-action${displayMode === "classic" ? " family-tree-tools-action-active" : ""}`}
            aria-pressed={displayMode === "classic"}
            onClick={() => onSelectDisplayMode("classic")}
          >
            <span className="family-tree-tools-icon" aria-hidden="true">⌘</span>
            <span>
              <strong>Класичне родове дерево</strong>
              <small>Поточне відображення на полотні</small>
            </span>
            {displayMode === "classic" ? <span className="family-tree-tools-badge">Активне</span> : null}
          </button>
          <button
            type="button"
            className={`family-tree-tools-action${displayMode === "direct-ancestors" ? " family-tree-tools-action-active" : ""}`}
            aria-pressed={displayMode === "direct-ancestors"}
            onClick={() => onSelectDisplayMode("direct-ancestors")}
          >
            <span className="family-tree-tools-icon" aria-hidden="true">⑂</span>
            <span>
              <strong>Родовід прямих предків</strong>
              <small>Окремий режим полотна · лише прямі предки зліва направо</small>
            </span>
            {displayMode === "direct-ancestors" ? <span className="family-tree-tools-badge">Активне</span> : null}
          </button>
          <button type="button" className="family-tree-tools-action" onClick={onOpenConstellationChart}>
            <span className="family-tree-tools-icon" aria-hidden="true">✧</span>
            <span>
              <strong>Сузір’я роду</strong>
              <small>Особи, покоління та родинні зв’язки на інтерактивній зоряній мапі</small>
            </span>
          </button>
          <button type="button" className="family-tree-tools-action" onClick={onOpenCircularChart}>
            <span className="family-tree-tools-icon" aria-hidden="true">◌</span>
            <span>
              <strong>Кругова діаграма предків</strong>
              <small>Від 1 до 16 поколінь прямих предків · інтерактивний огляд</small>
            </span>
          </button>
          <button type="button" className="family-tree-tools-action" onClick={onOpenAncestorFanChart}>
            <span className="family-tree-tools-icon" aria-hidden="true">◔</span>
            <span>
              <strong>Віялова діаграма предків</strong>
              <small>Батьківська гілка ліворуч, материнська — праворуч · до 16 поколінь</small>
            </span>
          </button>
          <button type="button" className="family-tree-tools-action" onClick={onOpenDescendantFanChart}>
            <span className="family-tree-tools-icon" aria-hidden="true">◕</span>
            <span>
              <strong>Віялова діаграма нащадків</strong>
              <small>Діти та їхні гілки за поколіннями · без сторонніх родин партнерів</small>
            </span>
          </button>
        </div>
      </div>
    </Modal>
  );
}
