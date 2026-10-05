import { useEffect, useState, type RefObject } from "react";

/**
 * A long list shown one fixed-size page at a time, so the page around it never grows. `reset` is
 * anything that changes what the list is (a filter, a search, a sort): when it changes, the list
 * goes back to its first page. A list that shrinks (wallets approved, say) keeps a valid page.
 */
export function usePages<T>(items: T[], pageSize: number, reset: unknown = null) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [reset, pageSize]);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(page, pages);
  const start = (current - 1) * pageSize;
  return { shown: items.slice(start, start + pageSize), page: current, pages, total: items.length, from: start + 1, to: Math.min(start + pageSize, items.length), setPage };
}

export type Pages = ReturnType<typeof usePages<unknown>>;

/** 1 … 4 5 6 … 40: the first, the last, and the current page with its neighbours. */
function numbers(page: number, pages: number): (number | null)[] {
  const keep = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
  const out: (number | null)[] = [];
  let last = 0;
  for (const n of [...keep].sort((a, b) => a - b)) {
    if (n - last === 2) out.push(n - 1);
    else if (n - last > 2) out.push(null);
    out.push(n);
    last = n;
  }
  return out;
}

const box = "min-h-10 min-w-10 cursor-pointer items-center justify-center px-3 text-sm disabled:cursor-not-allowed disabled:opacity-35";

/**
 * "21–40 of 1,000 assets   ‹ 1 2 3 … 50 ›". Renders nothing when everything fits on one page.
 * `top` is the list's own heading or container: after a page change it is brought back into view
 * if it has scrolled off the top, so the reader lands on the new page's first row. `compact` is for
 * narrow panels: the count and the arrows only.
 */
export function Pager({ p, noun, top, compact = false }: { p: Pages; noun: string; top?: RefObject<HTMLElement | null>; compact?: boolean }) {
  if (p.pages <= 1) return null;
  const go = (n: number) => {
    p.setPage(n);
    const el = top?.current;
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: "start" });
  };
  const fmt = (n: number) => n.toLocaleString("en-US");
  return (
    <nav aria-label={`Pages of ${noun}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-4">
      <span className="text-[13px] text-mute num" aria-live="polite">
        {p.from === p.to ? fmt(p.from) : `${fmt(p.from)}–${fmt(p.to)}`} of {fmt(p.total)} {noun}
      </span>
      <span className="flex items-center gap-1">
        <button type="button" onClick={() => go(p.page - 1)} disabled={p.page === 1} aria-label="Previous page" className={`${box} inline-flex border border-line hover:border-ink`}>‹</button>
        {compact ? (
          <span className="px-2 text-[13px] text-ink2 num">{p.page} / {p.pages}</span>
        ) : (
          <>
            <span className="px-2 text-[13px] text-ink2 num sm:hidden">Page {p.page} of {fmt(p.pages)}</span>
            {numbers(p.page, p.pages).map((n, i) =>
              n === null ? (
                <span key={`gap-${i}`} aria-hidden="true" className="hidden min-w-6 text-center text-mute sm:inline">…</span>
              ) : (
                <button key={n} type="button" onClick={() => go(n)} aria-current={n === p.page ? "page" : undefined} aria-label={`Page ${n}`}
                  className={`${box} hidden font-mono num sm:inline-flex ${n === p.page ? "bg-ink text-paper" : "hover:bg-surface"}`}>
                  {fmt(n)}
                </button>
              ),
            )}
          </>
        )}
        <button type="button" onClick={() => go(p.page + 1)} disabled={p.page === p.pages} aria-label="Next page" className={`${box} inline-flex border border-line hover:border-ink`}>›</button>
      </span>
    </nav>
  );
}
