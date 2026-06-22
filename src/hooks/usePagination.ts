import { useEffect, useMemo, useState } from "react";

export const pageSizeOptions = [20, 50, 100] as const;

export function usePagination<T>(items: T[], resetKey: string) {
  const [pageSize, setPageSizeState] = useState<number>(pageSizeOptions[0]);
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const startIndex = items.length ? (currentPage - 1) * pageSize : 0;
  const endIndex = Math.min(startIndex + pageSize, items.length);

  useEffect(() => {
    setPage(1);
  }, [resetKey]);

  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const pageItems = useMemo(
    () => items.slice(startIndex, endIndex),
    [endIndex, items, startIndex],
  );

  const setPageSize = (nextPageSize: number) => {
    setPageSizeState(nextPageSize);
    setPage(1);
  };

  return {
    page: currentPage,
    pageCount,
    pageItems,
    pageSize,
    startIndex,
    endIndex,
    setPage,
    setPageSize,
    totalItems: items.length,
  };
}
