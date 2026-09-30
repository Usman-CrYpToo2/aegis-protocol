import { useEffect, useRef, useState } from "react";

/**
 * "flash-up" or "flash-down" for a moment after `value` changes, so a price that moved while the
 * page was open is noticed. The first value never flashes.
 */
export function useChangeFlash(value: bigint | null): string {
  const previous = useRef(value);
  const [flash, setFlash] = useState({ cls: "", key: 0 });
  useEffect(() => {
    const before = previous.current;
    previous.current = value;
    if (before === null || value === null || before === value) return;
    setFlash((f) => ({ cls: value > before ? "flash-up" : "flash-down", key: f.key + 1 }));
    const id = window.setTimeout(() => setFlash((f) => ({ ...f, cls: "" })), 1400);
    return () => window.clearTimeout(id);
  }, [value]);
  return flash.cls;
}
