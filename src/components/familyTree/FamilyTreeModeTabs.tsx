import type { FamilyTreeGraphMode } from "../../types/familyTree";

const modeLabels: Record<FamilyTreeGraphMode, string> = {
  family: "Родина",
  ancestors: "Предки",
  descendants: "Нащадки",
  "direct-line": "Пряма лінія",
  compact: "Компакт",
};

export function FamilyTreeModeTabs({
  mode,
  onChange,
}: {
  mode: FamilyTreeGraphMode;
  onChange: (mode: FamilyTreeGraphMode) => void;
}) {
  return (
    <div className="family-tree-mode-tabs" role="tablist" aria-label="Режим родового дерева">
      {(Object.keys(modeLabels) as FamilyTreeGraphMode[]).map((item) => (
        <button
          key={item}
          type="button"
          role="tab"
          aria-selected={mode === item}
          className={mode === item ? "active" : ""}
          onClick={() => onChange(item)}
        >
          {modeLabels[item]}
        </button>
      ))}
    </div>
  );
}
