import { useMemo, useState } from "react";
import { Modal } from "../Modal";

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
  canExportGedcom: boolean;
  exportingGedcom: boolean;
  notice?: string;
  onSelectTree: (treeId: string) => void;
  onSelectResearch: (researchId: string) => void;
  onImportGedcom: () => void;
  onExportGedcom: () => void;
  onOpenCircularChart: () => void;
  onClose: () => void;
}

type ToolsView = "main" | "visualizations";

export function FamilyTreeToolsWindow({
  trees,
  selectedTreeId,
  researches,
  selectedResearchId,
  researchRequired,
  canImportGedcom,
  canExportGedcom,
  exportingGedcom,
  notice,
  onSelectTree,
  onSelectResearch,
  onImportGedcom,
  onExportGedcom,
  onOpenCircularChart,
  onClose,
}: FamilyTreeToolsWindowProps) {
  const [view, setView] = useState<ToolsView>("main");
  const selectedTree = useMemo(
    () => trees.find((tree) => tree.id === selectedTreeId) ?? trees[0],
    [selectedTreeId, trees],
  );

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
          </div>
        ) : (
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
        )}

        {notice ? <div className="family-tree-tools-notice" role="status">{notice}</div> : null}
      </div>
    </Modal>
  );
}
