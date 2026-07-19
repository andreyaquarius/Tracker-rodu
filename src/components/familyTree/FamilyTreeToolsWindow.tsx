import { useMemo, useState } from "react";
import { Modal } from "../Modal";
import {
  DEFAULT_FAMILY_TREE_APPEARANCE,
  DIRECT_LINEAGE_COLOR_PRESETS,
  STANDARD_DIRECT_LINEAGE_PALETTES,
  directLineageGroupingDepth,
  directLineagePalette,
  type DirectLineageGrouping,
  type FamilyTreeAppearancePreferences,
} from "../../utils/familyTreeAppearance.ts";

export interface FamilyTreeToolEntry {
  id: string;
  title: string;
  isDefault?: boolean;
}

interface FamilyTreeToolsWindowProps {
  trees: readonly FamilyTreeToolEntry[];
  selectedTreeId: string;
  researches: readonly { id: string; title: string }[];
  selectedResearchId: string;
  researchRequired: boolean;
  canImportGedcom: boolean;
  canBackupGedcomPhotos: boolean;
  gedcomPhotoBackupCount: number;
  canExportGedcom: boolean;
  exportingGedcom: boolean;
  appearance: FamilyTreeAppearancePreferences;
  notice?: string;
  onSelectTree: (treeId: string) => void;
  onSelectResearch: (researchId: string) => void;
  onImportGedcom: () => void;
  onOpenGedcomPhotoBackup: () => void;
  onExportGedcom: () => void;
  onOpenCircularChart: () => void;
  onAppearanceChange: (value: FamilyTreeAppearancePreferences) => void;
  onClose: () => void;
}

type ToolsView = "main" | "visualizations" | "settings";

const GROUPING_OPTIONS: readonly {
  value: DirectLineageGrouping;
  label: string;
  description: string;
}[] = [
  {
    value: "single",
    label: "Один колір",
    description: "Одна заливка для всієї прямої гілки.",
  },
  {
    value: "parents",
    label: "За батьками · 2 кольори",
    description: "Окремо батьківська і материнська гілки.",
  },
  {
    value: "grandparents",
    label: "За дідусями й бабусями · 4 кольори",
    description: "Окремий сектор для кожного дідуся та бабусі.",
  },
  {
    value: "great-grandparents",
    label: "За прадідусями й прабабусями · 8 кольорів",
    description: "Окремий сектор для кожної гілки прапредків.",
  },
];

const BRANCH_LABELS: Readonly<Record<DirectLineageGrouping, readonly string[]>> = {
  single: ["Усі прямі предки"],
  parents: ["Батьківська гілка", "Материнська гілка"],
  grandparents: [
    "Дід по батькові",
    "Бабуся по батькові",
    "Дід по матері",
    "Бабуся по матері",
  ],
  "great-grandparents": [
    "Батько діда по батькові",
    "Мати діда по батькові",
    "Батько бабусі по батькові",
    "Мати бабусі по батькові",
    "Батько діда по матері",
    "Мати діда по матері",
    "Батько бабусі по матері",
    "Мати бабусі по матері",
  ],
};

export function FamilyTreeToolsWindow({
  trees,
  selectedTreeId,
  researches,
  selectedResearchId,
  researchRequired,
  canImportGedcom,
  canBackupGedcomPhotos,
  gedcomPhotoBackupCount,
  canExportGedcom,
  exportingGedcom,
  appearance,
  notice,
  onSelectTree,
  onSelectResearch,
  onImportGedcom,
  onOpenGedcomPhotoBackup,
  onExportGedcom,
  onOpenCircularChart,
  onAppearanceChange,
  onClose,
}: FamilyTreeToolsWindowProps) {
  const [view, setView] = useState<ToolsView>("main");
  const selectedTree = useMemo(
    () => trees.find((tree) => tree.id === selectedTreeId) ?? trees[0],
    [selectedTreeId, trees],
  );
  const lineagePalette = useMemo(
    () => directLineagePalette(appearance),
    [appearance],
  );
  const lineageColorCount = Math.max(
    1,
    2 ** directLineageGroupingDepth(appearance.directLineageGrouping),
  );
  const lineageBranchLabels = BRANCH_LABELS[appearance.directLineageGrouping];
  const explicitBranchColors = appearance.directLineageBranchColors.length === 8;
  const selectBaseColor = (color: string) => onAppearanceChange({
    ...appearance,
    directLineageColor: color,
    directLineageBranchColors: [],
  });
  const selectBranchColor = (index: number, color: string) => {
    const colors = [...lineagePalette];
    if (!explicitBranchColors && lineageColorCount < 8) {
      const used = new Set(colors.slice(0, lineageColorCount));
      const fallback = directLineagePalette({
        ...appearance,
        directLineageGrouping: "great-grandparents",
        directLineageBranchColors: [],
      });
      let hiddenIndex = lineageColorCount;
      for (const candidate of fallback) {
        if (hiddenIndex >= 8) break;
        if (used.has(candidate)) continue;
        colors[hiddenIndex] = candidate;
        used.add(candidate);
        hiddenIndex += 1;
      }
    }
    colors[index] = color;
    onAppearanceChange({
      ...appearance,
      directLineageBranchColors: colors,
    });
  };

  return (
    <Modal
      title="Родове дерево"
      mode="window"
      minimizable={false}
      onClose={onClose}
    >
      <div className="family-tree-tools-window">
        <div className="family-tree-tools-summary">
          <span className="eyebrow">Активне дерево</span>
          <strong>{selectedTree?.title || "Родове дерево"}</strong>
          <small>Інструменти файлів, огляду та майбутніх візуалізацій.</small>
        </div>

        {trees.length > 1 ? (
          <label className="family-tree-tools-tree-select">
            <span>Вибрати дерево</span>
            <select
              value={selectedTree?.id ?? ""}
              onChange={(event) => onSelectTree(event.target.value)}
            >
              {trees.map((tree) => (
                <option key={tree.id} value={tree.id}>
                  {tree.title || "Дерево без назви"}
                  {tree.isDefault ? " · основне" : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {researches.length > 1 || researchRequired ? (
          <label className="family-tree-tools-tree-select">
            <span>Дослідження для імпорту GEDCOM</span>
            <select
              value={selectedResearchId}
              disabled={!researches.length}
              onChange={(event) => onSelectResearch(event.target.value)}
            >
              <option value="">Оберіть дослідження</option>
              {researches.map((research) => (
                <option key={research.id} value={research.id}>
                  {research.title || "Дослідження без назви"}
                </option>
              ))}
            </select>
            {researchRequired && !selectedResearchId ? (
              <small>Перед імпортом потрібно вибрати дослідження.</small>
            ) : null}
          </label>
        ) : null}

        {view === "main" ? (
          <div className="family-tree-tools-grid" role="group" aria-label="Інструменти родового дерева">
            <button
              type="button"
              className="family-tree-tools-action"
              disabled={!canImportGedcom}
              onClick={onImportGedcom}
            >
              <span className="family-tree-tools-icon" aria-hidden="true">⇧</span>
              <span>
                <strong>Імпорт GEDCOM</strong>
                <small>Завантажити осіб і зв’язки з файлу .ged</small>
              </span>
            </button>

            <button
              type="button"
              className="family-tree-tools-action"
              disabled={!canBackupGedcomPhotos || gedcomPhotoBackupCount === 0}
              onClick={onOpenGedcomPhotoBackup}
            >
              <span className="family-tree-tools-icon" aria-hidden="true">☁</span>
              <span>
                <strong>Зберегти фото з GEDCOM</strong>
                <small>
                  {gedcomPhotoBackupCount
                    ? `Незбережених фото: ${gedcomPhotoBackupCount.toLocaleString("uk-UA")}`
                    : "Усі доступні фото вже збережено"}
                </small>
              </span>
            </button>

            <button
              type="button"
              className="family-tree-tools-action"
              disabled={!canExportGedcom || exportingGedcom}
              onClick={onExportGedcom}
            >
              <span className="family-tree-tools-icon" aria-hidden="true">⇩</span>
              <span>
                <strong>{exportingGedcom ? "Готуємо GEDCOM…" : "Експорт GEDCOM"}</strong>
                <small>Зберегти повне активне дерево у файл</small>
              </span>
            </button>

            <button
              type="button"
              className="family-tree-tools-action"
              aria-haspopup="true"
              onClick={() => setView("visualizations")}
            >
              <span className="family-tree-tools-icon" aria-hidden="true">◉</span>
              <span>
                <strong>Відображення дерева</strong>
                <small>Класичні та майбутні графіки прямих предків</small>
              </span>
            </button>

            <button
              type="button"
              className="family-tree-tools-action"
              disabled
            >
              <span className="family-tree-tools-icon" aria-hidden="true">▥</span>
              <span>
                <strong>Статистика</strong>
                <small>Майбутній розділ · незабаром</small>
              </span>
            </button>

            <button
              type="button"
              className="family-tree-tools-action"
              aria-haspopup="true"
              onClick={() => setView("settings")}
            >
              <span className="family-tree-tools-icon" aria-hidden="true">⚙</span>
              <span>
                <strong>Налаштування дерева</strong>
                <small>Кольори прямої гілки та поділ родових секторів</small>
              </span>
            </button>
          </div>
        ) : view === "visualizations" ? (
          <div className="family-tree-tools-visualizations">
            <button
              type="button"
              className="button button-secondary family-tree-tools-back"
              onClick={() => setView("main")}
            >
              ← До інструментів
            </button>
            <div>
              <span className="eyebrow">Відображення дерева</span>
              <h3>Графіки прямих предків</h3>
              <p>Тут з’являтимуться окремі способи огляду родоводу.</p>
            </div>
            <div className="family-tree-tools-grid">
              <button
                type="button"
                className="family-tree-tools-action family-tree-tools-action-active"
                onClick={onClose}
              >
                <span className="family-tree-tools-icon" aria-hidden="true">⌘</span>
                <span>
                  <strong>Класичне родове дерево</strong>
                  <small>Поточне відображення на полотні</small>
                </span>
                <span className="family-tree-tools-badge">Активне</span>
              </button>
              <button
                type="button"
                className="family-tree-tools-action"
                onClick={onOpenCircularChart}
              >
                <span className="family-tree-tools-icon" aria-hidden="true">◌</span>
                <span>
                  <strong>Кругова діаграма предків</strong>
                  <small>Від 1 до 16 поколінь прямих предків · інтерактивний огляд</small>
                </span>
              </button>
            </div>
          </div>
        ) : (
          <div className="family-tree-tools-settings">
            <button
              type="button"
              className="button button-secondary family-tree-tools-back"
              onClick={() => setView("main")}
            >
              ← До інструментів
            </button>
            <div>
              <span className="eyebrow">Налаштування дерева</span>
              <h3>Заливка прямої гілки</h3>
              <p>
                Бокові родичі залишаються нейтральними, а прямі предки
                отримують вибрану заливку в усіх режимах дерева.
              </p>
            </div>

            <fieldset className="family-tree-lineage-fieldset">
              <legend>Основний колір</legend>
              <div className="family-tree-lineage-swatches" aria-label="Готові кольори заливки">
                {DIRECT_LINEAGE_COLOR_PRESETS.map(color => (
                  <button
                    key={color}
                    type="button"
                    className="family-tree-lineage-swatch"
                    style={{ backgroundColor: color }}
                    aria-label={`Вибрати колір ${color}`}
                    aria-pressed={appearance.directLineageColor === color}
                    onClick={() => selectBaseColor(color)}
                  />
                ))}
                <label className="family-tree-lineage-custom-color">
                  <span>Свій колір</span>
                  <input
                    type="color"
                    value={appearance.directLineageColor}
                    onChange={event => selectBaseColor(event.target.value)}
                  />
                </label>
              </div>
            </fieldset>

            <fieldset className="family-tree-lineage-fieldset">
              <legend>Розділення прямої гілки</legend>
              <div className="family-tree-lineage-grouping">
                {GROUPING_OPTIONS.map(option => (
                  <label key={option.value}>
                    <input
                      type="radio"
                      name="family-tree-lineage-grouping"
                      value={option.value}
                      checked={appearance.directLineageGrouping === option.value}
                      onChange={() => onAppearanceChange({
                        ...appearance,
                        directLineageGrouping: option.value,
                      })}
                    />
                    <span>
                      <strong>{option.label}</strong>
                      <small>{option.description}</small>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="family-tree-lineage-fieldset">
              <legend>Родичі при відкритті дерева</legend>
              <p>
                Партнери та прямі діти центральної особи показуються
                автоматично. Додатково можна одразу розкрити двоюрідні гілки.
              </p>
              <label className="family-tree-default-relatives">
                <input
                  type="checkbox"
                  checked={appearance.showCousinDescendantsByDefault}
                  onChange={event => onAppearanceChange({
                    ...appearance,
                    showCousinDescendantsByDefault: event.target.checked,
                  })}
                />
                <span>
                  <strong>Показувати двоюрідні гілки за замовчуванням</strong>
                  <small>
                    Двоюрідні родичі центральної особи та її батьків разом
                    з усіма доступними нащадками. Завантаження обмежене
                    безпечним лімітом дерева.
                  </small>
                </span>
              </label>
            </fieldset>

            {lineageColorCount > 1 ? (
              <fieldset className="family-tree-lineage-fieldset">
                <legend>Стандартні набори кольорів</legend>
                <div className="family-tree-lineage-palettes">
                  <button
                    type="button"
                    className="family-tree-lineage-palette-button"
                    aria-pressed={!explicitBranchColors}
                    onClick={() => onAppearanceChange({
                      ...appearance,
                      directLineageBranchColors: [],
                    })}
                  >
                    <span className="family-tree-lineage-palette-auto" aria-hidden="true" />
                    <strong>Автоматично від основного кольору</strong>
                  </button>
                  {STANDARD_DIRECT_LINEAGE_PALETTES.map(preset => {
                    const selected = preset.colors.every(
                      (color, index) => lineagePalette[index] === color,
                    );
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        className="family-tree-lineage-palette-button"
                        aria-pressed={explicitBranchColors && selected}
                        onClick={() => onAppearanceChange({
                          ...appearance,
                          directLineageBranchColors: [...preset.colors],
                        })}
                      >
                        <span className="family-tree-lineage-palette-colors" aria-hidden="true">
                          {preset.colors.slice(0, lineageColorCount).map((color, index) => (
                            <i key={`${preset.id}-${index}`} style={{ backgroundColor: color }} />
                          ))}
                        </span>
                        <strong>{preset.label}</strong>
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ) : null}

            {lineageColorCount > 1 ? (
              <fieldset className="family-tree-lineage-fieldset">
                <legend>Кольори окремих гілок</legend>
                <p>
                  Кожну гілку можна налаштувати вручну. Вибрані кольори
                  зберігаються для цього родового дерева.
                </p>
                <div className="family-tree-lineage-branches">
                  {lineageBranchLabels.map((label, index) => (
                    <label key={label} className="family-tree-lineage-branch-color">
                      <input
                        type="color"
                        value={lineagePalette[index] ?? appearance.directLineageColor}
                        aria-label={`Колір: ${label}`}
                        onChange={event => selectBranchColor(index, event.target.value)}
                      />
                      <span>
                        <strong>{label}</strong>
                        <small>{lineagePalette[index]}</small>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}

            <div className="family-tree-lineage-preview" aria-label="Попередній перегляд кольорів">
              {lineagePalette.slice(0, lineageColorCount).map((color, index) => (
                <span key={`${color}-${index}`} style={{ backgroundColor: color }} />
              ))}
            </div>

            <button
              type="button"
              className="button button-secondary family-tree-lineage-reset"
              onClick={() => onAppearanceChange({
                ...appearance,
                directLineageColor:
                  DEFAULT_FAMILY_TREE_APPEARANCE.directLineageColor,
                directLineageGrouping:
                  DEFAULT_FAMILY_TREE_APPEARANCE.directLineageGrouping,
                directLineageBranchColors: [],
              })}
            >
              Відновити стандартні кольори
            </button>
          </div>
        )}

        {notice ? <div className="family-tree-tools-notice" role="status">{notice}</div> : null}
      </div>
    </Modal>
  );
}
