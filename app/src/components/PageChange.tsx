import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";

const isLanding = (path: string) => path === "/";

/**
 * What happens between pages.
 *
 * - A new page opens at its top. Back and forward keep the place the browser restores, and a link
 *   to a section is left to the page that has it (Docs.tsx).
 * - Going between the landing page and the app, which are built differently (a floating nav over
 *   a lit hero, then a plain bar over paper), the screen cross-fades instead of cutting, so it
 *   reads as one product. Uses the browser's view transitions; without them, or for reduced
 *   motion, the link works as usual. Within the app, pages already rise in (App.tsx).
 */
export function PageChange() {
  const { pathname, hash } = useLocation();
  const type = useNavigationType();
  const navigate = useNavigate();
  // Set while a cross-fade waits for the new page to be on screen.
  const arrived = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    if (type !== "POP" && !hash) window.scrollTo(0, 0);
    arrived.current?.();
    arrived.current = null;
  }, [pathname, hash, type]);

  useEffect(() => {
    if (!("startViewTransition" in document)) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download") || a.origin !== window.location.origin) return;
      if (isLanding(a.pathname) === isLanding(window.location.pathname)) return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      // Stops the link's own navigation (it checks defaultPrevented); this one runs inside the fade.
      e.preventDefault();
      document.startViewTransition(
        () =>
          new Promise<void>((resolve) => {
            arrived.current = resolve;
            // Never hold the screen if the new page is slow to commit.
            window.setTimeout(resolve, 400);
            navigate(a.pathname + a.search + a.hash);
          }),
      );
    };
    // Capture, so this runs before the link's own click handler.
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [navigate]);

  return null;
}
