import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * A small ⓘ that holds the explanation a label would otherwise spell out. Opens on hover, focus
 * or tap; Escape or a tap elsewhere closes it. Screen readers get the text through the button.
 */
export function Hint({ children, label = "More information" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => { document.removeEventListener("keydown", close); document.removeEventListener("pointerdown", close); };
  }, [open]);

  return (
    <span ref={ref} className="relative inline-flex align-middle" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" aria-label={label} aria-describedby={open ? id : undefined} aria-expanded={open} onClick={() => setOpen((o) => !o)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        className="inline-flex size-5 cursor-help items-center justify-center rounded-full text-mute hover:text-ink">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.3" /><path d="M8 7v4.5M8 4.6v.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
      {open && (
        <span id={id} role="tooltip" className="absolute top-6 left-1/2 z-40 w-64 -translate-x-1/2 border border-ink bg-surface p-3 text-left font-sans text-[13px] leading-relaxed font-normal tracking-normal text-ink2 normal-case shadow-[0_8px_24px_rgb(22_20_15/0.12)]">
          {children}
        </span>
      )}
    </span>
  );
}
