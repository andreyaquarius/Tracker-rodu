import { pageSizeOptions } from "../hooks/usePagination";

interface PaginationControlsProps {
  totalItems: number;
  page: number;
  pageCount: number;
  pageSize: number;
  startIndex: number;
  endIndex: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

type PageToken = number | "ellipsis";

export function PaginationControls({
  totalItems,
  page,
  pageCount,
  pageSize,
  startIndex,
  endIndex,
  onPageChange,
  onPageSizeChange,
}: PaginationControlsProps) {
  if (!totalItems) return null;
  const pages = pageTokens(page, pageCount);
  return (
    <div className="pagination-bar" aria-label="Пагінація списку">
      <div className="pagination-summary">
        Показано {startIndex + 1}–{endIndex} з {totalItems}
      </div>
      <label className="pagination-size">
        <span>На сторінці</span>
        <select
          value={pageSize}
          onChange={(event) => onPageSizeChange(Number(event.target.value))}
        >
          {pageSizeOptions.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </label>
      <div className="pagination-pages" aria-label={`Сторінка ${page} з ${pageCount}`}>
        <button
          type="button"
          className="pagination-arrow"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          aria-label="Попередня сторінка"
        >
          ‹
        </button>
        {pages.map((token, index) => token === "ellipsis" ? (
          <span className="pagination-ellipsis" key={`ellipsis-${index}`}>…</span>
        ) : (
          <button
            type="button"
            className={token === page ? "active" : ""}
            key={token}
            onClick={() => onPageChange(token)}
            aria-current={token === page ? "page" : undefined}
            aria-label={`Сторінка ${token}`}
          >
            {token}
          </button>
        ))}
        <button
          type="button"
          className="pagination-arrow"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
          aria-label="Наступна сторінка"
        >
          ›
        </button>
      </div>
    </div>
  );
}

function pageTokens(page: number, pageCount: number): PageToken[] {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }
  const visible = new Set([1, pageCount, page - 1, page, page + 1]);
  if (page <= 3) {
    visible.add(2);
    visible.add(3);
    visible.add(4);
  }
  if (page >= pageCount - 2) {
    visible.add(pageCount - 1);
    visible.add(pageCount - 2);
    visible.add(pageCount - 3);
  }
  const sorted = Array.from(visible)
    .filter((item) => item >= 1 && item <= pageCount)
    .sort((left, right) => left - right);
  const tokens: PageToken[] = [];
  sorted.forEach((item, index) => {
    const previous = sorted[index - 1];
    if (previous && item - previous > 1) tokens.push("ellipsis");
    tokens.push(item);
  });
  return tokens;
}
