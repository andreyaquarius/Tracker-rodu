import { useState } from "react";

interface FamilyTreeNavigationProps {
  treeTitle?: string;
  treeToolsOpen: boolean;
  treeDisplayOpen: boolean;
  canDisplayTree: boolean;
  onOpenTreeTools: () => void;
  onOpenTreeDisplay: () => void;
}

export function FamilyTreeNavigation({
  treeTitle,
  treeToolsOpen,
  treeDisplayOpen,
  canDisplayTree,
  onOpenTreeTools,
  onOpenTreeDisplay,
}: FamilyTreeNavigationProps) {
  const [error, setError] = useState("");

  async function openWindow(trigger: HTMLButtonElement, onOpen: () => void) {
    setError("");
    // The windows live alongside the canvas, outside its native fullscreen element.
    if (document.fullscreenElement?.contains(trigger)) {
      try {
        await document.exitFullscreen();
      } catch {
        setError("Вийдіть із повноекранного режиму клавішею Esc і спробуйте ще раз.");
        return;
      }
    }
    onOpen();
  }

  return (
    <div className="family-tree-v2-navigation" role="group" aria-label="Навігація родового дерева">
      <button
        type="button"
        className="button button-secondary family-tree-v2-tools-trigger"
        title={`Адміністрування: ${treeTitle || "Родове дерево"}`}
        aria-haspopup="dialog"
        aria-expanded={treeToolsOpen}
        onClick={(event) => void openWindow(event.currentTarget, onOpenTreeTools)}
      >
        Адміністрування
        <span aria-hidden="true">⌄</span>
      </button>
      <button
        type="button"
        className="button button-secondary family-tree-v2-display-trigger"
        title={canDisplayTree ? "Оберіть дерево або діаграму" : "Спочатку додайте кореневу особу дерева"}
        aria-haspopup="dialog"
        aria-expanded={treeDisplayOpen}
        disabled={!canDisplayTree}
        onClick={(event) => void openWindow(event.currentTarget, onOpenTreeDisplay)}
      >
        Відображення дерева
        <span aria-hidden="true">⌄</span>
      </button>
      {error ? <small className="family-tree-v2-navigation-error" role="alert">{error}</small> : null}
    </div>
  );
}
