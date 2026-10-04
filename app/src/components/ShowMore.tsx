import { useEffect, useState } from "react";

/**
 * A long list shown a page at a time. `reset` is anything that changes what the list is (a filter,
 * a search): when it changes, the list starts again from its first page.
 */
export function usePaged<T>(items: T[], pageSize: number, reset: unknown = null) {
  const [count, setCount] = useState(pageSize);
  useEffect(() => setCount(pageSize), [reset, pageSize]);
  return { shown: items.slice(0, count), total: items.length, more: () => setCount((c) => c + pageSize), pageSize };
}

/** "Showing 25 of 1,000 · Show 25 more". Renders nothing when everything is already shown. */
export function ShowMore({ shown, total, pageSize, more, noun }: { shown: number; total: number; pageSize: number; more: () => void; noun: string }) {
  if (shown >= total) return null;
  const next = Math.min(pageSize, total - shown);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-5">
      <span className="text-sm text-mute num" aria-live="polite">
        Showing {shown.toLocaleString("en-US")} of {total.toLocaleString("en-US")} {noun}
      </span>
      <button type="button" onClick={more} className="min-h-11 cursor-pointer border border-ink px-5 text-sm font-semibold hover:bg-surface">
        Show {next.toLocaleString("en-US")} more
      </button>
    </div>
  );
}
