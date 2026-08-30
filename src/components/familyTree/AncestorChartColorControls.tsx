import { useMemo } from "react";
import {
  DIRECT_LINEAGE_COLOR_PRESETS,
  STANDARD_DIRECT_LINEAGE_PALETTES,
  directLineageGroupingDepth,
  directLineagePalette,
  type DirectLineageGrouping,
  type FamilyTreeAppearancePreferences,
} from "../../utils/familyTreeAppearance.ts";

const GROUPING_OPTIONS: readonly {
  value: DirectLineageGrouping;
  label: string;
}[] = [
  { value: "single", label: "Один колір" },
  { value: "parents", label: "2 гілки · батьки" },
  { value: "grandparents", label: "4 гілки · дідусі й бабусі" },
  { value: "great-grandparents", label: "8 гілок · прапредки" },
];

const BRANCH_LABELS: Readonly<Record<DirectLineageGrouping, readonly string[]>> = {
  single: ["Усі прямі предки"],
  parents: ["Батьківська", "Материнська"],
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

interface AncestorChartColorControlsProps {
  appearance: FamilyTreeAppearancePreferences;
  inheritedAppearance: FamilyTreeAppearancePreferences;
  dirty: boolean;
  onChange: (appearance: FamilyTreeAppearancePreferences) => void;
  onReset: () => void;
}

/**
 * Compact, chart-local editor. It deliberately never persists preferences:
 * the saved tree appearance is the initial value and the explicit reset
 * target, while experimentation is limited to the open chart window.
 */
export function AncestorChartColorControls({
  appearance,
  inheritedAppearance,
  dirty,
  onChange,
  onReset,
}: AncestorChartColorControlsProps) {
  const palette = useMemo(() => directLineagePalette(appearance), [appearance]);
  const colorCount = Math.max(
    1,
    2 ** directLineageGroupingDepth(appearance.directLineageGrouping),
  );
  const branchLabels = BRANCH_LABELS[appearance.directLineageGrouping];
  const inheritedPalette = useMemo(
    () => directLineagePalette(inheritedAppearance),
    [inheritedAppearance],
  );

  const selectBaseColor = (color: string) => onChange({
    ...appearance,
    directLineageColor: color,
    directLineageBranchColors: [],
  });
  const selectBranchColor = (index: number, color: string) => {
    const colors = [...palette];
    colors[index] = color;
    onChange({ ...appearance, directLineageBranchColors: colors });
  };

  return (
    <details className="ancestor-chart-color-menu">
      <summary title="Змінити кольори цієї діаграми">
        <span className="ancestor-chart-color-summary-swatches" aria-hidden="true">
          {palette.slice(0, Math.min(colorCount, 4)).map((color, index) => (
            <i key={`${color}:${index}`} style={{ backgroundColor: color }} />
          ))}
        </span>
        <span>Кольори</span>
        {dirty ? <i className="ancestor-chart-color-dirty" aria-label="Кольори змінено для цієї діаграми" /> : null}
      </summary>
      <div className="ancestor-chart-color-popover">
        <header>
          <strong>Кольори цієї діаграми</strong>
          <small>Початково взято з налаштувань дерева. Зміни діють лише до закриття вікна.</small>
        </header>

        <label className="ancestor-chart-color-grouping">
          <span>Розділення гілок</span>
          <select
            value={appearance.directLineageGrouping}
            onChange={(event) => onChange({
              ...appearance,
              directLineageGrouping: event.target.value as DirectLineageGrouping,
            })}
          >
            {GROUPING_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>

        <fieldset>
          <legend>Основний колір</legend>
          <div className="ancestor-chart-base-colors">
            {DIRECT_LINEAGE_COLOR_PRESETS.map((color) => (
              <button
                key={color}
                type="button"
                style={{ backgroundColor: color }}
                className={appearance.directLineageColor === color ? "is-selected" : ""}
                aria-label={`Основний колір ${color}`}
                aria-pressed={appearance.directLineageColor === color}
                onClick={() => selectBaseColor(color)}
              />
            ))}
            <label title="Власний основний колір">
              <input
                type="color"
                value={appearance.directLineageColor}
                aria-label="Власний основний колір"
                onChange={(event) => selectBaseColor(event.target.value)}
              />
            </label>
          </div>
        </fieldset>

        {colorCount > 1 ? (
          <fieldset>
            <legend>Готовий набір</legend>
            <div className="ancestor-chart-palette-presets">
              {STANDARD_DIRECT_LINEAGE_PALETTES.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => onChange({
                    ...appearance,
                    directLineageBranchColors: [...preset.colors],
                  })}
                >
                  <span aria-hidden="true">
                    {preset.colors.slice(0, colorCount).map((color, index) => (
                      <i key={`${preset.id}:${index}`} style={{ backgroundColor: color }} />
                    ))}
                  </span>
                  {preset.label}
                </button>
              ))}
            </div>
          </fieldset>
        ) : null}

        <fieldset>
          <legend>{colorCount === 1 ? "Колір предків" : "Кольори гілок"}</legend>
          <div className="ancestor-chart-branch-colors">
            {branchLabels.slice(0, colorCount).map((label, index) => (
              <label key={label}>
                <input
                  type="color"
                  value={colorCount === 1
                    ? appearance.directLineageColor
                    : palette[index] ?? appearance.directLineageColor}
                  aria-label={`Колір: ${label}`}
                  onChange={(event) => colorCount === 1
                    ? selectBaseColor(event.target.value)
                    : selectBranchColor(index, event.target.value)}
                />
                <span title={label}>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <footer>
          <span aria-label="Збережені кольори дерева" title="Збережені кольори дерева">
            {inheritedPalette.slice(0, Math.max(
              1,
              2 ** directLineageGroupingDepth(inheritedAppearance.directLineageGrouping),
            )).map((color, index) => (
              <i key={`${color}:${index}`} style={{ backgroundColor: color }} />
            ))}
          </span>
          <button type="button" disabled={!dirty} onClick={onReset}>
            Повернути кольори дерева
          </button>
        </footer>
      </div>
    </details>
  );
}
