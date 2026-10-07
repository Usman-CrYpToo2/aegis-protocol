/** A tick that draws itself. Give it a `key` that changes with each verification to redraw it. */
export function CheckDraw({ className = "size-[0.8em]" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`check-draw inline-block ${className}`}>
      <path d="M5 12.5l4.5 4.5L19 7.5" pathLength={1} />
    </svg>
  );
}

/**
 * A hairline that fills from the last check (`at`, ms since epoch) toward the next one, `every`
 * milliseconds later, and starts again whenever a new check lands.
 */
export function RefreshBar({ at, every, className = "w-16" }: { at: number; every: number; className?: string }) {
  return (
    <span aria-hidden="true" title={`Checked again every ${Math.round(every / 1000)} seconds`} className={`block h-0.5 overflow-hidden bg-track ${className}`}>
      <span key={at} className="refresh-fill block h-full bg-green" style={{ animationDuration: `${every}ms` }} />
    </span>
  );
}
