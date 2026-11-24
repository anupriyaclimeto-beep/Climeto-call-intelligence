import { useEffect, useMemo, useState } from 'react';

export function usePagination(items = [], defaultPageSize = 12) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);

  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

  useEffect(() => {
    if (page > totalPages) {
      setPage(1);
    }
  }, [page, totalPages]);

  const pageItems = useMemo(() => {
    const start = (page - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, page, pageSize]);

  function handlePageChange(nextPage) {
    const clamped = Math.min(Math.max(1, nextPage), totalPages);
    setPage(clamped);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function handlePageSizeChange(nextSize) {
    setPageSize(Number(nextSize) || defaultPageSize);
    setPage(1);
  }

  return {
    page,
    pageSize,
    totalItems,
    totalPages,
    pageItems,
    setPage: handlePageChange,
    setPageSize: handlePageSizeChange,
  };
}

function getVisiblePages(current, total) {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const pages = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) pages.push('...');
  for (let p = start; p <= end; p += 1) pages.push(p);
  if (end < total - 1) pages.push('...');
  pages.push(total);
  return pages;
}

export function PaginationBar({
  page,
  pageSize,
  totalItems,
  totalPages,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 50],
}) {
  if (totalItems === 0) return null;

  const startIdx = (page - 1) * pageSize + 1;
  const endIdx = Math.min(page * pageSize, totalItems);
  const visiblePages = getVisiblePages(page, totalPages);

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '0.75rem',
        marginTop: '1rem',
        paddingTop: '0.85rem',
        borderTop: '1px solid #e2e8f0',
        fontSize: '0.82rem',
        color: '#475569',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', flexWrap: 'wrap' }}>
        <span>
          Showing <strong>{startIdx}–{endIdx}</strong> of <strong>{totalItems}</strong>
        </span>
        {onPageSizeChange ? (
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            aria-label="Items per page"
            style={{
              padding: '0.28rem 0.55rem',
              borderRadius: '8px',
              border: '1px solid #cbd5e1',
              background: '#f8fafc',
              color: '#0f172a',
              fontSize: '0.8rem',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {pageSizeOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt} / page
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {totalPages > 1 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="ghost-button"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
            style={{ padding: '0.32rem 0.7rem', fontSize: '0.8rem', opacity: page <= 1 ? 0.5 : 1 }}
          >
            ← Prev
          </button>

          {visiblePages.map((p, idx) =>
            p === '...' ? (
              <span key={`dots-${idx}`} style={{ padding: '0 0.25rem', color: '#94a3b8' }}>
                …
              </span>
            ) : (
              <button
                key={p}
                type="button"
                onClick={() => onPageChange(p)}
                style={{
                  minWidth: '32px',
                  padding: '0.32rem 0.55rem',
                  borderRadius: '8px',
                  fontSize: '0.8rem',
                  fontWeight: p === page ? 700 : 500,
                  cursor: 'pointer',
                  border: p === page ? '1px solid #2563eb' : '1px solid #cbd5e1',
                  background: p === page ? '#2563eb' : '#ffffff',
                  color: p === page ? '#ffffff' : '#1e293b',
                }}
              >
                {p}
              </button>
            ),
          )}

          <button
            type="button"
            className="ghost-button"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
            style={{ padding: '0.32rem 0.7rem', fontSize: '0.8rem', opacity: page >= totalPages ? 0.5 : 1 }}
          >
            Next →
          </button>
        </div>
      ) : null}
    </div>
  );
}

