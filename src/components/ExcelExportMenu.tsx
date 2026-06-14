import { useDismissibleDetails } from "../hooks/useDismissibleDetails";

export function ExcelExportMenu({
  filteredCount,
  totalCount,
  onExportFiltered,
  onExportAll,
}: {
  filteredCount: number;
  totalCount: number;
  onExportFiltered: () => void;
  onExportAll: () => void;
}) {
  const detailsRef = useDismissibleDetails();
  const run = (action: () => void) => {
    action();
    if (detailsRef.current) detailsRef.current.open = false;
  };

  return (
    <details className="excel-export-menu" ref={detailsRef}>
      <summary className="button button-secondary">Експорт Excel</summary>
      <div className="excel-export-options">
        <button type="button" onClick={() => run(onExportFiltered)}>
          За поточними фільтрами
          <small>{filteredCount} записів</small>
        </button>
        <button type="button" onClick={() => run(onExportAll)}>
          Усі записи розділу
          <small>{totalCount} записів</small>
        </button>
      </div>
    </details>
  );
}
