import { useEffect, useRef } from "react";
import { Link, NavLink, useLocation, useParams } from "react-router-dom";
import { DOC_GROUPS, DOC_PAGES, figures } from "../docs/content";
import { usePlatform } from "../hooks/usePlatform";
import { NotFoundPage } from "./NotFound";

const href = (slug: string) => (slug ? `/docs/${slug}` : "/docs");

function Sidebar({ current, onPick }: { current: string; onPick?: () => void }) {
  return (
    <nav aria-label="Documentation" className="flex flex-col gap-7">
      {DOC_GROUPS.map((g) => (
        <div key={g} className="flex flex-col">
          <p className="kicker m-0 pb-2">{g}</p>
          {DOC_PAGES.filter((p) => p.group === g).map((p) => (
            <NavLink key={p.slug} to={href(p.slug)} end onClick={onPick} aria-current={p.slug === current ? "page" : undefined}
              className={`-ml-px border-l-2 py-1.5 pl-3 text-[15px] no-underline ${p.slug === current ? "border-ink font-semibold text-ink" : "border-transparent text-ink2 hover:border-line hover:text-ink"}`}>
              {p.title}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

export function DocsPage() {
  const { slug = "" } = useParams();
  const { hash } = useLocation();
  const platform = usePlatform();
  const menu = useRef<HTMLDetailsElement>(null);
  const index = DOC_PAGES.findIndex((p) => p.slug === slug);
  const page = DOC_PAGES[index];

  useEffect(() => {
    if (!page) return;
    document.title = `${page.title} — Aegis docs`;
    return () => { document.title = "Aegis — The Registry"; };
  }, [page]);

  // A new page starts at its top, unless the link named a section.
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
    else window.scrollTo({ top: 0 });
  }, [slug, hash]);

  if (!page) return <NotFoundPage />;
  const prev = DOC_PAGES[index - 1];
  const next = DOC_PAGES[index + 1];
  const f = figures(platform.data);

  return (
    <div className="shell grid gap-8 pt-8 pb-24 lg:grid-cols-[230px_minmax(0,1fr)] lg:gap-14 lg:pt-12">
      <aside className="hidden lg:block">
        <div className="sticky top-8 max-h-[calc(100dvh-4rem)] overflow-y-auto pb-6"><Sidebar current={slug} /></div>
      </aside>

      <details ref={menu} className="group border-y border-rule lg:hidden">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between text-[15px] [&::-webkit-details-marker]:hidden">
          <span><span className="text-mute">Docs · </span><span className="font-semibold">{page.title}</span></span>
          <span aria-hidden="true" className="font-mono text-mute group-open:rotate-180">▾</span>
        </summary>
        <div className="pt-2 pb-5"><Sidebar current={slug} onPick={() => { if (menu.current) menu.current.open = false; }} /></div>
      </details>

      <article className="min-w-0 pb-4">
        <p className="kicker m-0">{page.group}</p>
        <h1 className="m-0 mt-2 font-serif text-[44px] leading-[1.02] font-normal sm:text-[56px]">{page.title}</h1>
        <div className="mt-5">{page.body(f)}</div>

        <nav aria-label="Previous and next" className="mt-16 grid gap-3 border-t border-ink pt-6 sm:grid-cols-2">
          {prev ? (
            <Link to={href(prev.slug)} className="flex flex-col gap-1 border border-line p-4 no-underline hover:border-ink">
              <span className="text-sm text-mute">← Previous</span><span className="font-semibold text-ink">{prev.title}</span>
            </Link>
          ) : <span />}
          {next && (
            <Link to={href(next.slug)} className="flex flex-col gap-1 border border-line p-4 text-right no-underline hover:border-ink">
              <span className="text-sm text-mute">Next →</span><span className="font-semibold text-ink">{next.title}</span>
            </Link>
          )}
        </nav>
      </article>
    </div>
  );
}
