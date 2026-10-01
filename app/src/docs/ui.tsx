import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * The docs' building blocks. Flat and square like the rest of the app; the serif carries the
 * headings, the sans carries the reading, mono carries anything you might copy.
 */

export function Lede({ children }: { children: ReactNode }) {
  return <p className="m-0 max-w-[68ch] text-lg leading-relaxed text-ink2 sm:text-xl">{children}</p>;
}

export function H2({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="group mt-12 mb-0 scroll-mt-24 font-serif text-[30px] leading-tight font-normal sm:text-[34px]">
      {children}
      <a href={`#${id}`} aria-label="Link to this section" className="ml-2 text-xl text-mute no-underline opacity-0 group-hover:opacity-100 focus:opacity-100">#</a>
    </h2>
  );
}

export function H3({ children }: { children: ReactNode }) {
  return <h3 className="mt-8 mb-0 text-lg font-semibold">{children}</h3>;
}

export function P({ children }: { children: ReactNode }) {
  return <p className="m-0 mt-4 max-w-[68ch] text-[16px] leading-[1.7] text-ink2">{children}</p>;
}

export function List({ children, ordered = false }: { children: ReactNode; ordered?: boolean }) {
  const Tag = ordered ? "ol" : "ul";
  return <Tag className={`m-0 mt-4 flex max-w-[68ch] flex-col gap-2 pl-5 text-[16px] leading-[1.7] text-ink2 ${ordered ? "list-decimal" : "list-disc"} marker:text-mute`}>{children}</Tag>;
}

/** A word on screen, exactly as the app shows it. */
export const UI = ({ children }: { children: ReactNode }) => <strong className="font-semibold text-ink">{children}</strong>;
export const Code = ({ children }: { children: ReactNode }) => <code className="bg-track/60 px-1 py-0.5 font-mono text-[0.88em] text-ink">{children}</code>;

const TONE = {
  note: { border: "border-blue", label: "Note", text: "text-blue" },
  warn: { border: "border-amber", label: "Important", text: "text-amber" },
  good: { border: "border-green", label: "Guarantee", text: "text-green" },
} as const;

export function Callout({ kind = "note", title, children }: { kind?: keyof typeof TONE; title?: string; children: ReactNode }) {
  const t = TONE[kind];
  return (
    <aside className={`mt-6 max-w-[68ch] border-l-4 ${t.border} bg-surface px-5 py-4`}>
      <p className={`m-0 font-mono text-xs tracking-[0.12em] uppercase ${t.text}`}>{title ?? t.label}</p>
      <div className="mt-1.5 text-[15px] leading-relaxed text-ink2">{children}</div>
    </aside>
  );
}

/** Numbered steps for guides and the tutorial. Each step may show what you should see. */
export function Steps({ children }: { children: ReactNode }) {
  return <ol className="m-0 mt-6 flex max-w-[68ch] list-none flex-col p-0 [counter-reset:step]">{children}</ol>;
}

export function Step({ title, children, result }: { title: ReactNode; children?: ReactNode; result?: ReactNode }) {
  return (
    <li className="relative border-l border-rule pb-7 pl-10 [counter-increment:step] last:border-transparent last:pb-0">
      <span aria-hidden="true" className="absolute top-0 -left-[15px] flex size-[30px] items-center justify-center rounded-full border border-ink bg-paper font-mono text-[13px] before:content-[counter(step)]" />
      <p className="m-0 pt-0.5 text-[16px] font-semibold text-ink">{title}</p>
      {children && <div className="mt-1.5 text-[16px] leading-[1.7] text-ink2">{children}</div>}
      {result && <p className="m-0 mt-2.5 border border-rule bg-surface px-4 py-2.5 text-[15px] text-ink2"><span className="font-mono text-xs tracking-wider text-green uppercase">You should see </span>{result}</p>}
    </li>
  );
}

/**
 * A table on wider screens. On a phone each row becomes a small labelled block instead, because a
 * column hidden off to the side is a column nobody reads.
 */
export function Table({ head, rows, caption }: { head: ReactNode[]; rows: ReactNode[][]; caption?: string }) {
  return (
    <>
      <div className="mt-6 border-t border-ink sm:hidden">
        {rows.map((r, i) => (
          <div key={i} className="flex flex-col gap-2 border-b border-rule py-4">
            <p className="m-0 font-semibold text-ink">{r[0]}</p>
            {r.slice(1).map((c, j) => (
              <div key={j} className="text-[15px] leading-relaxed text-ink2">
                {head[j + 1] ? <span className="block font-mono text-[11px] tracking-wider text-mute uppercase">{head[j + 1]}</span> : null}
                {c}
              </div>
            ))}
          </div>
        ))}
      </div>
      <TableWide head={head} rows={rows} caption={caption} />
    </>
  );
}

function TableWide({ head, rows, caption }: { head: ReactNode[]; rows: ReactNode[][]; caption?: string }) {
  return (
    <div className="mt-6 max-w-full overflow-x-auto border-y border-ink max-sm:hidden">
      <table className="w-full min-w-[560px] border-collapse text-left text-[15px]">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>{head.map((h, i) => <th key={i} scope="col" className="border-b border-rule px-3 py-3 align-bottom font-mono text-xs font-normal tracking-wider text-mute uppercase first:pl-0">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-rule last:border-0">
              {r.map((c, j) => j === 0
                ? <th key={j} scope="row" className="px-3 py-3 align-top font-semibold text-ink first:pl-0">{c}</th>
                : <td key={j} className="px-3 py-3 align-top leading-relaxed text-ink2">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Term and meaning pairs, for the glossary and for short definitions. */
export function Terms({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="m-0 mt-6 max-w-[68ch] border-t border-ink">
      {items.map(([term, meaning]) => (
        <div key={term} id={`term-${term.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} className="scroll-mt-24 border-b border-rule py-4 sm:grid sm:grid-cols-[180px_1fr] sm:gap-6">
          <dt className="font-semibold text-ink">{term}</dt>
          <dd className="m-0 mt-1 text-[15px] leading-relaxed text-ink2 sm:mt-0">{meaning}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Cards that send each kind of reader to the right page. */
export function Paths({ items }: { items: { to: string; kicker: string; title: string; text: string }[] }) {
  return (
    <div className="mt-6 grid gap-3 sm:grid-cols-3">
      {items.map((c) => (
        <Link key={c.to} to={c.to} className="flex flex-col gap-2 border border-line bg-surface p-5 text-ink no-underline hover:border-ink hover:text-ink">
          <span className="font-mono text-xs tracking-[0.12em] text-mute uppercase">{c.kicker}</span>
          <span className="font-serif text-2xl leading-tight">{c.title}</span>
          <span className="text-[15px] leading-relaxed text-ink2">{c.text}</span>
          <span className="mt-auto pt-1 text-sm font-semibold text-blue">Read →</span>
        </Link>
      ))}
    </div>
  );
}

export function DocLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link to={to} className="text-blue underline underline-offset-[3px] hover:text-blue-deep">{children}</Link>;
}

export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue underline underline-offset-[3px] hover:text-blue-deep">{children} ↗</a>;
}

// ------------------------------------------------------------------------------------------------
// Diagrams. Built from boxes rather than drawn, so they reflow on a phone and read in order for a
// screen reader.
// ------------------------------------------------------------------------------------------------

function Box({ tone, kicker, title, lines }: { tone: "ink" | "ox" | "blue" | "plain"; kicker: string; title: string; lines: string[] }) {
  const cls = tone === "ink" ? "bg-ink text-paper border-ink" : tone === "blue" ? "bg-blue text-white border-blue" : tone === "ox" ? "border-ox bg-surface text-ink" : "border-line bg-surface text-ink";
  const sub = tone === "ink" ? "text-line" : tone === "blue" ? "text-[#C9D3F0]" : "text-mute";
  return (
    <div className={`flex flex-1 flex-col gap-1 border p-4 ${cls}`}>
      <span className={`font-mono text-[11px] tracking-[0.12em] uppercase ${sub}`}>{kicker}</span>
      <span className="font-serif text-[22px] leading-tight">{title}</span>
      {lines.map((l) => <span key={l} className={`text-[13px] leading-snug ${sub}`}>{l}</span>)}
    </div>
  );
}

const Arrow = ({ label }: { label: string }) => (
  <div className="flex shrink-0 items-center justify-center gap-2 py-1 font-mono text-[11px] text-mute md:w-28 md:flex-col md:py-0">
    <span aria-hidden="true" className="text-lg leading-none md:hidden">↓</span>
    <span aria-hidden="true" className="hidden text-lg leading-none md:block">→</span>
    <span className="text-center">{label}</span>
  </div>
);

/** One asset, two tokens, and the escrow between them. */
export function TokenModel({ sec = "TWRA", wrp = "cTWRA" }: { sec?: string; wrp?: string }) {
  return (
    <figure className="m-0 mt-8">
      <div className="flex flex-col md:flex-row md:items-stretch">
        <Box tone="ink" kicker="The security" title={sec} lines={["The legal claim on the asset", "Only wallets the issuer approved", "Upside’s rules on every transfer"]} />
        <Arrow label="locked 1 : 1" />
        <Box tone="ox" kicker="Aegis escrow" title="The vault" lines={["Holds the whole supply", "Owned by the program, not a person", "Checked by every bridge move"]} />
        <Arrow label="backs" />
        <Box tone="blue" kicker="The wrapper" title={wrp} lines={["Created by Meteora at the sale", "Anyone can buy, hold and sell", "One per unit in the vault"]} />
      </div>
      <figcaption className="mt-3 text-[13px] text-mute">The security stays inside the compliance rules. The wrapper trades freely. The escrow is what makes them equal.</figcaption>
    </figure>
  );
}

/** The four stages a launch moves through, in order. */
export function Lifecycle() {
  const stages: [string, string, string][] = [
    ["01", "File", "The security is created with its rules and a fixed supply."],
    ["02", "Escrow", "The whole supply is locked in the Aegis vault."],
    ["03", "Offer", "Meteora sells one wrapper per unit on a bonding curve."],
    ["04", "Graduate", "A permanent pool opens, and so does the bridge."],
  ];
  return (
    <ol className="m-0 mt-8 grid list-none grid-cols-1 border-t border-ink p-0 sm:grid-cols-2 lg:grid-cols-4">
      {stages.map(([n, t, d]) => (
        <li key={n} className="flex flex-col gap-1.5 border-b border-rule py-4 sm:pr-5 lg:border-b-0">
          <span className="font-mono text-xs text-mute">{n}</span>
          <span className="font-serif text-[26px] leading-none">{t}</span>
          <span className="text-[14px] leading-relaxed text-ink2">{d}</span>
        </li>
      ))}
    </ol>
  );
}

/** A question that opens in place, for FAQs. Native <details>, so it works with a keyboard and without script. */
export function Faq({ items }: { items: [string, ReactNode][] }) {
  return (
    <div className="mt-6 max-w-[68ch] border-t border-ink">
      {items.map(([q, a]) => (
        <details key={q} id={`q-${q.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "")}`} className="group scroll-mt-24 border-b border-rule">
          <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-6 py-3 text-[17px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
            {q}
            <span aria-hidden="true" className="font-mono text-xl font-normal text-mute group-open:rotate-45">+</span>
          </summary>
          <div className="pb-5 text-[16px] leading-[1.7] text-ink2">{a}</div>
        </details>
      ))}
    </div>
  );
}

/** A word defined in the glossary. The link carries the definition, and the hover shows it. */
export function G({ term, children, tip }: { term: string; children: ReactNode; tip?: string }) {
  return (
    <Link to={`/docs/glossary#term-${term.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} title={tip} className="text-ink underline decoration-line decoration-dotted underline-offset-4 hover:decoration-ink">
      {children}
    </Link>
  );
}

/** Where a launch's supply ends up, as one bar and a legend. Widths are shares of the total. */
export function SupplyBar({ parts }: { parts: { label: string; value: string; share: number; tone: string }[] }) {
  return (
    <figure className="m-0 mt-6 max-w-[68ch]">
      <div aria-hidden="true" className="flex h-8 overflow-hidden border border-ink">
        {parts.map((p) => <span key={p.label} className={p.tone} style={{ width: `${Math.max(p.share * 100, 1.2)}%` }} />)}
      </div>
      <figcaption className="mt-3 grid gap-2 text-[14px] text-ink2 sm:grid-cols-3">
        {parts.map((p) => (
          <span key={p.label} className="flex items-start gap-2">
            <span aria-hidden="true" className={`mt-1 size-3 shrink-0 border border-ink ${p.tone}`} />
            <span><strong className="text-ink">{p.value}</strong> {p.label}</span>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/** The sale curve: price rising from the opening price to the graduation price, under the ceiling. */
export function CurveFigure({ open, close, ceiling, quote }: { open: string; close: string; ceiling: string; quote: string }) {
  return (
    <figure className="m-0 mt-6 max-w-[68ch] border border-line bg-surface p-4 sm:p-6">
      <svg viewBox="0 0 520 230" className="w-full" role="img" aria-label={`The price rises along the curve from ${open} to ${close} ${quote}, below the ceiling of ${ceiling}.`}>
        <line x1="40" y1="30" x2="500" y2="30" stroke="#7E2A1E" strokeDasharray="5 5" />
        <text x="500" y="22" textAnchor="end" fontFamily="IBM Plex Mono, monospace" fontSize="11" fill="#7E2A1E">ceiling · {ceiling}</text>
        <path d="M40 190 C 170 186 300 120 470 52 L 470 200 L 40 200 Z" fill="#E4DECF" />
        <path d="M40 190 C 170 186 300 120 470 52" fill="none" stroke="#16140F" strokeWidth="2.5" />
        <circle cx="40" cy="190" r="5" fill="#16140F" />
        <circle cx="470" cy="52" r="6" fill="#1D3A8A" />
        <text x="52" y="150" fontFamily="IBM Plex Mono, monospace" fontSize="11" fill="#3B372F">opening · {open}</text>
        <text x="462" y="160" textAnchor="end" fontFamily="IBM Plex Mono, monospace" fontSize="11" fill="#1D3A8A">graduation · {close}</text>
        <line x1="40" y1="200" x2="500" y2="200" stroke="#A89F8A" />
        <text x="40" y="220" fontFamily="IBM Plex Mono, monospace" fontSize="11" fill="#5C574C">wrappers sold →</text>
        <text x="470" y="220" textAnchor="end" fontFamily="IBM Plex Mono, monospace" fontSize="11" fill="#5C574C">raise target reached</text>
      </svg>
      <figcaption className="mt-2 text-[13px] text-mute">Each purchase moves the price up the curve; each sale moves it down. The sale ends where the raise target is reached, always at or below the ceiling.</figcaption>
    </figure>
  );
}

/** Primary and secondary markets, side by side: who may take part in each. */
export function TwoMarkets() {
  const col = (kicker: string, title: string, who: string, items: string[], tone: string) => (
    <div className={`flex flex-1 flex-col gap-2 border p-5 ${tone}`}>
      <span className="font-mono text-[11px] tracking-[0.12em] text-mute uppercase">{kicker}</span>
      <span className="font-serif text-[24px] leading-tight text-ink">{title}</span>
      <span className="text-[14px] font-semibold text-ink">{who}</span>
      <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[14px] leading-relaxed text-ink2">{items.map((i) => <li key={i}>{i}</li>)}</ul>
    </div>
  );
  return (
    <figure className="m-0 mt-6 flex flex-col gap-3 md:flex-row">
      {col("Primary market · gated", "The register and the bridge", "Approved holders only", ["Hold the security", "Redeem wrappers for the security", "Deposit the security for wrappers"], "border-ink bg-surface")}
      {col("Secondary market · open", "The curve, then the pool", "Anyone", ["Buy and sell the wrapper during the sale", "Trade it on its Meteora pool after graduation", "Hold it in any wallet"], "border-blue bg-surface")}
    </figure>
  );
}
