import type { FamilyTreeGraphDto, FamilyTreeGraphMode } from "../../types/familyTree";
import { FamilyTreeModeTabs } from "./FamilyTreeModeTabs";

export type FamilyTreeRelationshipScope = "direct" | "family" | "all";

export interface FamilyTreeToolbarState {
  treeId: string;
  rootPersonId: string;
  mode: FamilyTreeGraphMode;
  generationsUp: number;
  generationsDown: number;
  relationshipScope: FamilyTreeRelationshipScope;
  includeAdoptive: boolean;
  includeStep: boolean;
  includeFoster: boolean;
  includeGuardian: boolean;
  includeDisputed: boolean;
}

export type FamilyTreeSearchResult = {
  occurrenceId: string;
  personId: string;
  displayName: string;
  description: string;
  generation: number;
};

export function FamilyTreeToolbar({
  graph,
  state,
  searchQuery,
  searchResults,
  onChange,
  onSearchChange,
  onSelectSearchResult,
  onExportGedcom,
  onRefresh,
  isLoading,
}: {
  graph: FamilyTreeGraphDto | null;
  state: FamilyTreeToolbarState;
  searchQuery: string;
  searchResults: FamilyTreeSearchResult[];
  onChange: (patch: Partial<FamilyTreeToolbarState>) => void;
  onSearchChange: (value: string) => void;
  onSelectSearchResult: (result: FamilyTreeSearchResult) => void;
  onExportGedcom?: () => void | Promise<void>;
  onRefresh: () => void;
  isLoading: boolean;
}) {
  const selectedTreeId = state.treeId || graph?.treeId || "";

  return (
    <section className="panel family-tree-toolbar">
      <div className="family-tree-toolbar-main">
        <label>
          <span>Дерево</span>
          <select
            value={selectedTreeId}
            onChange={(event) => onChange({ treeId: event.target.value })}
            disabled={!graph?.treeId}
          >
            {graph?.tree ? (
              <option value={graph.treeId}>{graph.tree.title || "Родове дерево"}</option>
            ) : (
              <option value="">Дерево ще не створено</option>
            )}
          </select>
        </label>

        <label className="family-tree-search-field">
          <span>Пошук у дереві</span>
          <input
            type="search"
            value={searchQuery}
            placeholder="Ім’я, рік або місце"
            onChange={(event) => onSearchChange(event.target.value)}
            disabled={!graph?.nodes.length}
          />
          {searchQuery.trim() ? (
            <div className="family-tree-search-results">
              {searchResults.length ? (
                searchResults.map((result) => (
                  <button
                    key={result.occurrenceId}
                    type="button"
                    onClick={() => onSelectSearchResult(result)}
                  >
                    <strong>{result.displayName}</strong>
                    <small>{result.description || `Покоління ${result.generation}`}</small>
                  </button>
                ))
              ) : (
                <div>Збігів у поточному дереві не знайдено</div>
              )}
            </div>
          ) : null}
        </label>

        <label>
          <span>Поколінь угору</span>
          <input
            type="number"
            min={1}
            value={state.generationsUp}
            onChange={(event) => onChange({ generationsUp: generationDepthValue(event.target.value) })}
          />
        </label>

        {onExportGedcom ? (
          <button type="button" className="button button-secondary" onClick={() => void onExportGedcom()} disabled={!graph?.nodes.length}>
            GEDCOM
          </button>
        ) : null}

        <button type="button" className="button button-secondary" onClick={onRefresh} disabled={isLoading}>
          {isLoading ? "Оновлення..." : "Оновити"}
        </button>
      </div>

      <div className="family-tree-toolbar-bottom">
        <FamilyTreeModeTabs mode={state.mode} onChange={(mode) => onChange({ mode })} />
        <div className="family-tree-toggles">
          <label>
            <input
              type="checkbox"
              checked={state.includeAdoptive}
              onChange={(event) => onChange({ includeAdoptive: event.target.checked })}
            />
            <span>Усиновлення</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={state.includeStep}
              onChange={(event) => onChange({ includeStep: event.target.checked })}
            />
            <span>Нерідні</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={state.includeFoster}
              onChange={(event) => onChange({ includeFoster: event.target.checked })}
            />
            <span>Опіка/виховання</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={state.includeGuardian}
              onChange={(event) => onChange({ includeGuardian: event.target.checked })}
            />
            <span>Опікуни</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={state.includeDisputed}
              onChange={(event) => onChange({ includeDisputed: event.target.checked })}
            />
            <span>Сумнівні</span>
          </label>
        </div>
      </div>
    </section>
  );
}

function generationDepthValue(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, parsed);
}
