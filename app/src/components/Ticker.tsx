import { useEffect, useRef, useState } from "react";

const NUMBER = /\d[\d,]*(?:\.\d+)?/;
const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const numberIn = (text: string): number | null => {
  const m = NUMBER.exec(text);
  return m ? Number(m[0].replace(/,/g, "")) : null;
};

/** The first number in `text` set to `value`, written the same way: same decimals, same grouping. */
function withNumber(text: string, value: number): string {
  const m = NUMBER.exec(text);
  if (!m) return text;
  const raw = m[0];
  const decimals = raw.includes(".") ? raw.split(".")[1]!.length : 0;
  const formatted = value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: raw.includes(",") });
  return text.slice(0, m.index) + formatted + text.slice(m.index + raw.length);
}

/**
 * A figure that moves to its value instead of jumping, keeping the text's own format ("$26,182",
 * "6,000.00", "4").
 *
 * - `appear` (headline figures): counts up from zero the first time it shows. Later refreshes show
 *   at once; the change flash already says a number moved, and re-counting would distract.
 * - `change` (balances): shows as it is at first, then counts from the old value to the new one
 *   whenever it changes, so money arriving or leaving is something you see happen.
 *
 * Text without a number, and anyone who asked for reduced motion, get the text as it is.
 */
export function Ticker({ text, ms = 900, mode = "appear" }: { text: string; ms?: number; mode?: "appear" | "change" }) {
  const [shown, setShown] = useState(() => (mode === "appear" && NUMBER.test(text) && !reduced() ? withNumber(text, 0) : text));
  // The value currently on screen, and whether the one-time count of `appear` has run.
  const current = useRef<number | null>(mode === "appear" ? 0 : numberIn(text));
  const counted = useRef(mode === "change");

  useEffect(() => {
    const target = numberIn(text);
    const from = current.current;
    const animate = target !== null && from !== null && from !== target && !reduced() && (mode === "change" || !counted.current);
    if (!animate) {
      setShown(text);
      current.current = target;
      return;
    }
    counted.current = true;
    const start = performance.now();
    let frame = 0;
    let finished = false;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const value = from + (target - from) * (1 - Math.pow(1 - t, 3));
      current.current = value;
      setShown(t < 1 ? withNumber(text, value) : text);
      if (t < 1) frame = requestAnimationFrame(step);
      else {
        finished = true;
        current.current = target;
      }
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      // Interrupted (the value changed, or React re-ran the effect): the next run starts from
      // wherever the count had reached, and an unfinished first count is allowed to run again.
      if (!finished && mode === "appear") counted.current = false;
    };
  }, [text, ms, mode]);

  return <>{shown}</>;
}
