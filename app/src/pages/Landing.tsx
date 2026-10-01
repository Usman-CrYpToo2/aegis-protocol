import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { config, explorerUrl } from "../config";
import { AEGIS_PROGRAM_ID } from "../chain/ids";
import { METEORA_PROTOCOL_FEE_PCT } from "../chain/meteora";
import { ProgramNotDeployedError } from "../chain/registry";
import { LogoMark } from "../components/Logo";
import { Rosette } from "../components/landing/Rosette";
import { useNow } from "../hooks/useNow";
import { usePlatform } from "../hooks/usePlatform";
import { useRegistry } from "../hooks/useRegistry";
import { formatUnits } from "../lib/amount";
import { ARCHETYPE_CEILING } from "../lib/curve";
import { entryName, summarize, type LandingSummary } from "../lib/landing";
import { poolFeeRange } from "../lib/terms";
import { NETWORK_NAME as NETWORK, REPO_URL as REPO } from "../lib/site";

const wrap = "mx-auto w-full max-w-[1440px] px-4 sm:px-8 lg:px-20";
const kb = "font-mono text-[11px] uppercase tracking-[0.14em] sm:text-xs";
const h2 = "font-serif text-[44px] leading-[0.95] sm:text-[56px] lg:text-[72px]";
const pill = "inline-flex min-h-12 items-center justify-center gap-2 rounded-full px-6 text-[15px] font-semibold sm:min-h-14 sm:px-7 sm:text-base";
const whole = (v: bigint) => formatUnits(v, 0);
const pct = (v: number) => `${v.toFixed(2).replace(/\.?0+$/, "")}%`;

const SECTIONS: [string, string][] = [["how", "How it works"], ["guarantees", "Guarantees"], ["proof", "Proof"], ["fees", "Fees"], ["questions", "Questions"]];

function subscribeMotion(cb: () => void) {
  const m = window.matchMedia("(prefers-reduced-motion: reduce)");
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}
/** SVG motion (animateMotion) ignores CSS, so the reduced-motion choice is read here too. */
function useReducedMotion() {
  return useSyncExternalStore(subscribeMotion, () => window.matchMedia("(prefers-reduced-motion: reduce)").matches, () => false);
}

function ago(ms: number, now: number) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 5 ? "just now" : s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
}

// ------------------------------------------------------------------------------------------------
// Top of the page
// ------------------------------------------------------------------------------------------------

function Banner({ summary }: { summary: LandingSummary | null }) {
  const f = summary?.featured;
  if (!f) return null;
  return (
    <Link to={`/asset/${f.entry.launch.realRwaMint.toBase58()}`} className="flex min-h-10 items-center justify-center gap-2.5 bg-ink px-4 text-center text-[13px] text-paper no-underline hover:text-paper">
      <span className="lp-pulse size-1.5 shrink-0 rounded-full bg-[#6FCF97]" aria-hidden="true" />
      <span><span className="hidden sm:inline">{entryName(f.entry)} is open on {config.cluster} · offering </span><span className="sm:hidden">{entryName(f.entry)} · </span><strong className="num">{f.pct}%</strong> filled</span>
      <span className="underline underline-offset-[3px]">Watch it fill →</span>
    </Link>
  );
}

function Nav() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  return (
    <header className="sticky top-3 z-30 px-4 pt-3 sm:pt-5">
      <div className="relative mx-auto flex w-full max-w-fit items-center justify-between gap-4 rounded-full border border-rule bg-surface/85 py-1.5 pr-1.5 pl-4 shadow-[0_6px_24px_rgb(22_20_15/0.06)] backdrop-blur-md max-md:max-w-none lg:gap-7 lg:pl-5">
        <Link to="/" aria-label="Aegis home" className="flex items-center gap-2.5 text-ink no-underline">
          <LogoMark size={24} />
          <span className="font-serif text-[22px] tracking-[0.08em]">AEGIS</span>
        </Link>
        <nav aria-label="Sections" className="hidden md:flex">
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="rounded-full px-3.5 py-2.5 text-sm text-ink2 no-underline hover:bg-[#ECE7DB] hover:text-ink">{label}</a>
          ))}
          <Link to="/docs" className="rounded-full px-3.5 py-2.5 text-sm text-ink2 no-underline hover:bg-[#ECE7DB] hover:text-ink">Docs</Link>
        </nav>
        <div className="flex items-center gap-1">
          <Link to="/registry" className="inline-flex min-h-11 items-center rounded-full bg-ink px-5 text-sm font-semibold text-paper no-underline hover:bg-ink2 hover:text-paper">Launch app</Link>
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="lp-menu" aria-label={open ? "Close menu" : "Open menu"}
            className="flex size-11 cursor-pointer items-center justify-center rounded-full hover:bg-[#ECE7DB] md:hidden">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              {open ? <path d="M5 5l10 10M15 5L5 15" /> : <path d="M3 6h14M3 10h14M3 14h14" />}
            </svg>
          </button>
        </div>
        {open && (
          <nav id="lp-menu" aria-label="Sections" className="absolute inset-x-0 top-[calc(100%+8px)] flex flex-col rounded-3xl border border-rule bg-surface p-2 shadow-[0_18px_40px_rgb(22_20_15/0.12)] md:hidden">
            {SECTIONS.map(([id, label]) => (
              <a key={id} href={`#${id}`} onClick={() => setOpen(false)} className="flex min-h-12 items-center rounded-2xl px-4 text-[15px] text-ink no-underline hover:bg-[#ECE7DB]">{label}</a>
            ))}
            <Link to="/docs" className="flex min-h-12 items-center rounded-2xl px-4 text-[15px] text-ink no-underline hover:bg-[#ECE7DB]">Docs</Link>
            <Link to="/launch" className="flex min-h-12 items-center rounded-2xl px-4 text-[15px] font-semibold text-blue no-underline hover:bg-[#ECE7DB]">Launch an asset →</Link>
          </nav>
        )}
      </div>
    </header>
  );
}

function SealFigure({ summary, state, readAt }: { summary: LandingSummary | null; state: "loading" | "ok" | "error" | "absent"; readAt: number }) {
  const now = useNow(1000);
  const short = summary?.backing === "short";
  const seal = summary?.seal;
  const lines =
    state === "loading" ? ["reading the chain…"]
    : state === "error" ? ["can’t reach the network"]
    : state === "absent" ? [`not deployed on ${config.cluster} yet`]
    : seal ? [`${whole(seal.escrowed)} in escrow`, `${whole(seal.circulating)} circulating`]
    : ["no wrapper issued yet"];
  const label = short
    ? `Backing short on ${summary!.short} ${summary!.short === 1 ? "entry" : "entries"}`
    : seal ? `Live backing seal: ${whole(seal.escrowed)} held in escrow, ${whole(seal.circulating)} in circulation` : "The backing seal: every wrapper is matched one for one in escrow";
  return (
    <figure aria-label={label} className="relative m-0 aspect-square w-[min(100%,358px)] justify-self-center sm:w-[520px] lg:w-full lg:max-w-[640px] lg:justify-self-end">
      <Rosette className="absolute inset-0 size-full opacity-55" />
      <div className="absolute top-1/2 left-1/2 flex size-[38%] -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center gap-0.5 rounded-full border bg-surface text-center sm:gap-1"
        style={{ borderColor: short ? "var(--color-error)" : "var(--color-ox)", boxShadow: `0 0 0 8px var(--color-paper), 0 0 0 9px ${short ? "var(--color-error)" : "var(--color-ox)"}` }}>
        <span className={`${kb} hidden !text-[10px] sm:block lg:max-[1399px]:hidden ${short ? "text-error" : "text-ox"}`}>Every entry</span>
        <span className={`font-serif leading-[0.95] ${short ? "text-error text-[40px] sm:text-[60px]" : "text-[46px] sm:text-[64px] lg:text-[52px] xl:text-[72px]"}`}>{short ? "short" : "1:1"}</span>
        {lines.map((l) => <span key={l} className="hidden px-3 font-mono text-[11px] text-mute num sm:block lg:max-[1399px]:hidden min-[1400px]:text-xs">{l}</span>)}
        {state === "ok" && (
          <span className={`mt-1 flex items-center gap-1.5 font-mono text-[10px] sm:text-[11px] ${short ? "text-error" : "text-green"}`}>
            <span className={`lp-pulse size-1.5 rounded-full ${short ? "bg-error" : "bg-green"}`} aria-hidden="true" />
            {short ? "bridge stopped" : `verified ${ago(readAt, now)}`}
          </span>
        )}
      </div>
    </figure>
  );
}

function Hero({ summary, state, readAt }: { summary: LandingSummary | null; state: "loading" | "ok" | "error" | "absent"; readAt: number }) {
  return (
    <section className={`${wrap} grid items-center gap-6 overflow-x-clip pt-6 lg:min-h-[820px] lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:pt-0`}>
      <div className="relative z-10 flex flex-col gap-5 lg:gap-7">
        <span className={`${kb} lp-rise hidden self-start rounded-full border border-rule bg-surface px-3.5 py-2 !tracking-[0.1em] text-mute sm:inline-flex`}>Real-world assets · Solana · Meteora</span>
        <h1 className="lp-rise m-0 font-serif text-[52px] leading-[0.94] tracking-[-0.015em] sm:text-[76px] lg:text-[clamp(56px,6vw,96px)]" style={{ animationDelay: ".08s" }}>
          Real assets.<br />Traded freely.<br /><em className="text-ox">Backed</em> one for one.
        </h1>
        <p className="lp-rise m-0 max-w-[520px] text-[17px] leading-relaxed text-ink2 sm:text-xl" style={{ animationDelay: ".16s" }}>
          A regulated security, locked in escrow. A wrapper anyone can trade. The chain proves they are equal, every block.
        </p>
        <div className="lp-rise flex flex-col gap-2.5 sm:flex-row sm:gap-3" style={{ animationDelay: ".24s" }}>
          <Link to="/registry" className={`${pill} bg-blue text-white no-underline hover:bg-blue-deep hover:text-white`}>Explore the registry</Link>
          <Link to="/launch" className={`${pill} border border-ink text-ink no-underline hover:bg-ink hover:text-paper`}>Launch an asset</Link>
        </div>
      </div>
      <div className="order-first grid lg:order-none">
        <SealFigure summary={summary} state={state} readAt={readAt} />
      </div>
    </section>
  );
}

function Stat({ label, children, delay, tone = "" }: { label: string; children: ReactNode; delay: number; tone?: string }) {
  return (
    <div className="flex flex-col gap-1.5 py-4 not-first:border-rule max-sm:[&:nth-child(-n+2)]:border-b sm:py-7 max-sm:even:border-l max-sm:even:pl-4 sm:not-first:border-l sm:not-first:pl-8">
      <span className={`${kb} !text-[10px] text-mute sm:!text-xs`}>{label}</span>
      <span className={`lp-roll font-serif text-[32px] leading-[1.05] num lg:text-[56px] ${tone}`}><span style={{ animationDelay: `${delay}s` }}>{children}</span></span>
    </div>
  );
}

function Stats({ summary, state }: { summary: LandingSummary | null; state: "loading" | "ok" | "error" | "absent" }) {
  const dash = state === "loading" ? <span className="inline-block h-[0.8em] w-24 animate-pulse bg-track align-middle" aria-label="Loading" /> : "—";
  const s = state === "ok" ? summary : null;
  const backed = !s ? { text: dash, tone: "" }
    : s.backing === "short" ? { text: `${s.short} short`, tone: "text-error" }
    : s.backing === "unknown" ? { text: "unverified", tone: "text-amber" }
    : s.backing === "none" ? { text: "—", tone: "text-mute" }
    : { text: "100%", tone: "text-green" };
  return (
    <section aria-label="Live numbers" className={wrap}>
      <div className="grid grid-cols-2 border-y border-ink sm:grid-cols-4">
        <Stat label="Units in escrow" delay={0.3}>{s ? whole(s.escrowed) : dash}</Stat>
        <Stat label={`Raised${s?.raised ? `, ${s.raised.symbol}` : ""}`} delay={0.42}>{s ? (s.raised ? formatUnits(s.raised.total, s.raised.decimals, { maxFraction: 0 }) : "0") : dash}</Stat>
        <Stat label="Assets registered" delay={0.54}>{s ? s.assets : dash}</Stat>
        <Stat label="Backed" delay={0.66} tone={backed.tone}>{backed.text}</Stat>
      </div>
    </section>
  );
}

function Tape({ summary }: { summary: LandingSummary | null }) {
  const items = summary?.tape ?? [];
  if (!items.length) return null;
  // Short registries repeat until the line is wider than any screen, then the whole run is doubled
  // so the loop has no seam.
  const run = Array.from({ length: Math.max(1, Math.ceil(8 / items.length)) }, () => items).flat();
  const row = (copy: number) => run.map((t, i) => {
    const tone = t.tone === "good" ? "text-[#6FCF97]" : t.tone === "bad" ? "text-[#F2A196]" : "";
    const body = <>{t.tone === "plain" ? "●" : "◆"} {t.strong && <strong>{t.strong}</strong>} {t.text}</>;
    return t.mint ? (
      <Link key={`${copy}-${i}`} to={`/asset/${t.mint}`} tabIndex={copy || i >= items.length ? -1 : undefined} className={`text-paper no-underline hover:text-paper hover:underline ${tone}`}>{body}</Link>
    ) : <span key={`${copy}-${i}`} className={tone}>{body}</span>;
  });
  return (
    <section aria-label="The registry right now" className="mt-12 overflow-hidden bg-ink py-3.5 text-paper sm:mt-16 sm:py-[18px]">
      <div className="lp-tape flex w-max gap-14 font-mono text-xs whitespace-nowrap sm:text-sm">
        <div className="flex gap-14">{row(0)}</div>
        <div className="flex gap-14" aria-hidden="true">{row(1)}</div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------
// How it works
// ------------------------------------------------------------------------------------------------

const BRIDGE_PATH = "M 0 60 C 160 60 200 20 360 20 S 560 60 720 60";

function BridgeDemo({ summary }: { summary: LandingSummary | null }) {
  const [dir, setDir] = useState<"deposit" | "redeem">("deposit");
  const still = useReducedMotion();
  const named = summary?.featured?.entry ?? null;
  const sec = named?.label?.symbol ?? "RWA";
  const wrp = named?.wrapperLabel?.symbol ?? `c${sec}`;
  const seg = (id: typeof dir, label: string) => (
    <label className={`cursor-pointer rounded-full px-5 py-2.5 text-sm font-semibold has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-blue ${dir === id ? "bg-ink text-paper" : "text-ink"}`}>
      <input type="radio" name="lp-dir" value={id} checked={dir === id} onChange={() => setDir(id)} className="sr-only" />{label}
    </label>
  );
  // Three tokens travel the bridge in the chosen direction. With reduced motion the path itself
  // turns blue instead.
  const tokens = still ? null : [0, -1.2, -2.4].map((begin, i) => (
    <circle key={i} r="16" fill="#1D3A8A">
      <animateMotion dur="3.6s" begin={`${begin}s`} repeatCount="indefinite" path={BRIDGE_PATH} keyPoints={dir === "deposit" ? "0;1" : "1;0"} keyTimes="0;1" calcMode="linear" />
    </circle>
  ));
  const side = (icon: ReactNode, title: string, sub: string) => (
    <div className="flex flex-col items-center gap-1.5 text-center sm:gap-2.5">
      {icon}
      <span className="font-serif text-lg sm:text-[28px]">{title}</span>
      <span className="font-mono text-[11px] text-mute sm:text-xs">{sub.split(" · ")[0]}<span className="max-sm:hidden"> · {sub.split(" · ")[1]}</span></span>
    </div>
  );
  return (
    <section id="how" className={`${wrap} lp-reveal grid scroll-mt-28 items-center gap-8 pt-16 sm:pt-28 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16 lg:pt-36`}>
      <div className="flex flex-col gap-4 sm:gap-5">
        <span className={`${kb} text-ox`}>The idea</span>
        <h2 className={`m-0 ${h2}`}>One asset.<br />Two forms.</h2>
        <p className="m-0 text-[17px] leading-relaxed text-ink2 sm:text-lg">The security stays with approved holders. The wrapper goes anywhere. Swap between them one for one, with no fee and no price impact.</p>
      </div>
      <div className="flex flex-col gap-4">
        <fieldset className="m-0 flex self-end rounded-full border border-ink p-1">
          <legend className="sr-only">Direction</legend>
          {seg("deposit", "Deposit")}
          {seg("redeem", "Redeem")}
        </fieldset>
        <div className="grid grid-cols-[72px_minmax(0,1fr)_72px] items-center rounded-[20px] border border-ink bg-surface p-5 shadow-[6px_6px_0_var(--color-ink)] sm:grid-cols-[150px_minmax(0,1fr)_150px] sm:rounded-3xl sm:p-10 sm:shadow-[12px_12px_0_var(--color-ink)]">
          {side(
            <svg viewBox="0 0 120 120" className="size-14 sm:size-[120px]" aria-hidden="true"><rect x="10" y="20" width="100" height="90" rx="10" fill="#16140F" /><circle cx="60" cy="65" r="24" fill="none" stroke="#F4F1EA" strokeWidth="2" /><circle cx="60" cy="65" r="4" fill="#F4F1EA" /><path d="M60 41v8M60 81v8M36 65h8M76 65h8" stroke="#F4F1EA" strokeWidth="2" /></svg>,
            "Escrow", `${sec} · the security`,
          )}
          <svg viewBox="0 -10 720 100" className="h-16 w-full overflow-visible sm:h-[180px]" aria-hidden="true">
            <path d={BRIDGE_PATH} fill="none" stroke={still ? "#1D3A8A" : "#CFC7B5"} strokeWidth="3" strokeDasharray="6 8" />
            <g key={dir}>{tokens}</g>
            <g transform="translate(360 20)"><circle r="40" fill="#7E2A1E" /><text y="12" textAnchor="middle" fontFamily="Instrument Serif, serif" fontSize="36" fill="#F4F1EA">1:1</text></g>
          </svg>
          {side(
            <svg viewBox="0 0 120 120" className="size-14 sm:size-[120px]" aria-hidden="true"><circle cx="60" cy="62" r="46" fill="#1D3A8A" /><circle cx="60" cy="62" r="36" fill="none" stroke="#FFFFFF" strokeWidth="1.5" /><text x="60" y="72" textAnchor="middle" fontFamily="Instrument Serif, serif" fontSize="30" fill="#FFFFFF">c</text></svg>,
            "Your wallet", `${wrp} · the wrapper`,
          )}
          <p aria-live="polite" className="col-span-full m-0 pt-5 text-center font-mono text-xs text-mute sm:pt-7 sm:text-[13px]">
            {dir === "deposit"
              ? `500 ${sec} locked → 500 ${wrp} minted · escrow and supply rise together`
              : `500 ${wrp} burned → 500 ${sec} released · only to wallets the issuer approved`}
          </p>
        </div>
      </div>
    </section>
  );
}

function Guarantees({ platform }: { platform: ReturnType<typeof usePlatform>["data"] }) {
  const p = platform?.config;
  const card = "lp-card flex flex-col justify-between gap-6 rounded-[20px] p-6 sm:rounded-3xl sm:p-9";
  const h3 = "m-0 font-serif text-[30px] leading-none font-normal sm:text-[34px]";
  const body = "m-0 text-[15px] leading-relaxed";
  const aegis = p?.aegisLpSharePct ?? 10;
  const months = p ? `${Math.max(1, p.minVestingMonths)} to ${p.maxVestingMonths} months` : "a set number of months";
  const ceilings = Object.values(ARCHETYPE_CEILING).map((c) => c.multiple.replace(/0×$/, "×"));
  return (
    <section id="guarantees" className={`${wrap} lp-reveal scroll-mt-28 pt-20 sm:pt-28 lg:pt-36`}>
      <div className="flex flex-col justify-between gap-4 pb-8 lg:flex-row lg:items-end lg:pb-10">
        <h2 className={`m-0 ${h2}`}>Rules a launch<br className="max-sm:hidden" /> can’t break.</h2>
        <p className="m-0 max-w-[380px] text-[17px] leading-relaxed text-ink2">Every launch goes through the same program. These hold for all of them, whoever the issuer is.</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:gap-5 md:grid-cols-2 lg:auto-rows-[360px] lg:grid-cols-3">
        <article className={`${card} bg-ink text-paper md:col-span-2 lg:grid lg:grid-cols-[1fr_1.2fr] lg:items-end`}>
          <div className="flex flex-col justify-between gap-3 self-stretch">
            <span className={`${kb} text-line`}>Price ceiling</span>
            <div>
              <h3 className={`${h3} mb-2.5 sm:text-[40px]`}>The curve can’t<br />run away.</h3>
              <p className={`${body} text-line`}>The issuer picks {ceilings.slice(0, -1).join(", ")} or {ceilings.at(-1)}. The sale can never price above it.</p>
            </div>
          </div>
          <svg viewBox="0 0 360 170" className="w-full overflow-visible" role="img" aria-label="A bonding curve rising gently to a dashed ceiling line">
            <line x1="0" y1="12" x2="360" y2="12" stroke="#E8B4A8" strokeWidth="1.5" strokeDasharray="5 5" />
            <text x="360" y="4" textAnchor="end" fontFamily="IBM Plex Mono, monospace" fontSize="11" fill="#E8B4A8">ceiling</text>
            <path d="M 8 150 C 90 148 150 120 210 80 S 300 22 352 16" fill="none" stroke="#F4F1EA" strokeWidth="2.5" />
            <path d="M 8 150 C 90 148 150 120 210 80 S 300 22 352 16 L 352 170 L 8 170 Z" fill="rgb(244 241 234 / 0.08)" />
            <circle r="7" fill="#6FCF97" cx="352" cy="16">
              <animateMotion dur="5s" repeatCount="indefinite" path="M -344 134 C -262 132 -202 104 -142 64 S -52 6 0 0" keyPoints="0;1" keyTimes="0;1" keySplines="0.22 1 0.36 1" calcMode="spline" />
            </circle>
          </svg>
        </article>
        <article className={`${card} border border-rule bg-surface`}>
          <span className={`${kb} text-mute`}>Supply</span>
          <div className="flex items-center gap-4">
            <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#16140F" strokeWidth="1.4" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 018 0v3" /><circle cx="12" cy="15.5" r="1.5" fill="#16140F" /></svg>
            <span className="font-serif text-[44px] leading-none">Fixed</span>
          </div>
          <div><h3 className={`${h3} mb-2`}>No new wrappers. Ever.</h3><p className={`${body} text-ink2`}>Mint rights sit with the program, not the issuer.</p></div>
        </article>
        <article className={`${card} border border-rule bg-surface`}>
          <span className={`${kb} text-mute`}>Liquidity</span>
          <div className="flex flex-col gap-2">
            <div className="flex h-9 overflow-hidden rounded-lg border border-ink" aria-hidden="true">
              <span className="bg-ox" style={{ width: `${aegis}%` }} />
              <span className="relative flex-1 bg-[repeating-linear-gradient(90deg,var(--color-blue)_0_14px,var(--color-surface)_14px_16px)]"><span className="lp-grow absolute inset-0 bg-surface/75" /></span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-mute">
              <span className="flex items-center gap-1.5"><span className="size-2 bg-ox" />Aegis, forever</span>
              <span className="flex items-center gap-1.5"><span className="size-2 bg-blue" />issuer, unlocks monthly or locked forever</span>
            </div>
          </div>
          <div><h3 className={`${h3} mb-2`}>No day-one exit.</h3><p className={`${body} text-ink2`}>The pool is locked. Part forever, part over {months}.</p></div>
        </article>
        <article className={`${card} bg-blue text-white`}>
          <span className={`${kb} text-[#C9D3F0]`}>Compliance</span>
          <div className="flex flex-col gap-2.5 text-[15px]">
            <div className="flex justify-between rounded-xl bg-white/12 px-4 py-3"><span>Buy the wrapper</span><span className="font-mono">open ✓</span></div>
            <div className="flex justify-between rounded-xl bg-white/12 px-4 py-3"><span>Hold the security</span><span className="font-mono">approved only</span></div>
          </div>
          <h3 className={h3}>KYC only where the law needs it.</h3>
        </article>
        <article className={`${card} border border-rule bg-surface`}>
          <span className={`${kb} text-mute`}>For issuers</span>
          <div className="flex flex-wrap items-center gap-2.5" aria-hidden="true">
            <span className="lp-sig flex gap-2.5">{Array.from({ length: 8 }, (_, i) => <span key={i} className="size-[18px] rounded-full border-[1.5px] border-ink" style={{ animationDelay: `${i}s` }} />)}</span>
            <span className="ml-1 font-mono text-xs text-mute">→ 1 approval</span>
          </div>
          <div><h3 className={`${h3} mb-2`}>Eight steps. One approval.</h3><p className={`${body} text-ink2`}>Your wallet asks once. If anything stops halfway, the launch picks up where it stopped.</p></div>
        </article>
      </div>
    </section>
  );
}

function Stages() {
  const steps = [
    ["File", "The security is created with its compliance rules and a fixed supply."],
    ["Escrow", "Every unit is locked in the Aegis vault before anything is sold."],
    ["Offer", "Meteora sells one wrapper per unit on a bonding curve. Anyone can buy."],
    ["Graduate", "The last purchase opens a permanent pool, and the bridge. Unsold wrappers are burned."],
  ];
  return (
    <section className={`${wrap} lp-reveal pt-20 sm:pt-28 lg:pt-36`}>
      <div className="flex flex-col justify-between gap-3 pb-8 sm:flex-row sm:items-end lg:pb-10">
        <h2 className={`m-0 ${h2}`}>From filing to<br />open market.</h2>
        <span className={`${kb} text-mute`}>A launch, start to finish</span>
      </div>
      <div className="relative h-0.5 bg-rule max-sm:hidden"><span className="lp-stage-bar absolute inset-0 bg-ox" /></div>
      <ol className="m-0 grid list-none grid-cols-1 gap-0 p-0 sm:grid-cols-2 sm:gap-8 lg:grid-cols-4">
        {steps.map(([title, text], i) => (
          <li key={title} className="lp-st flex gap-4 border-rule pt-5 max-sm:border-t max-sm:pb-5 sm:flex-col sm:gap-3 sm:pt-7" style={{ animationDelay: `${i * 3}s` }}>
            <span className="font-mono text-[13px]">0{i + 1}</span>
            <span className="flex flex-col gap-2 sm:gap-3">
              <strong className="font-serif text-[32px] leading-none font-normal sm:text-[40px]">{title}</strong>
              <span className="text-[15px] leading-normal">{text}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Paths() {
  const peek = "mt-2 -mr-6 -mb-6 ml-6 hidden sm:flex flex-col gap-3.5 rounded-tl-2xl p-5 sm:-mr-11 sm:-mb-11 sm:ml-11 sm:p-6";
  return (
    <section className={`${wrap} lp-reveal grid gap-3 pt-20 sm:gap-5 sm:pt-28 md:grid-cols-2 lg:pt-36`}>
      <Link to="/registry" className="lp-card flex flex-col gap-6 overflow-hidden rounded-3xl border border-ink bg-surface p-6 text-ink no-underline hover:text-ink sm:rounded-[28px] sm:p-11">
        <span className={`${kb} text-blue`}>For investors</span>
        <h3 className="m-0 font-serif text-[36px] leading-none font-normal sm:text-[52px]">Buy real assets.<br />No permission needed.</h3>
        <span className="font-semibold text-blue sm:hidden">Explore the registry →</span>
        <div aria-hidden="true" className={`${peek} border border-rule bg-paper shadow-[-10px_-10px_30px_rgb(22_20_15/0.06)]`}>
          <div className="flex items-baseline justify-between"><span className="font-serif text-[26px]">Buy cTWRA</span><span className="font-mono text-xs text-green">✓ backed 1 : 1</span></div>
          <div className="flex items-center justify-between rounded-[10px] border border-ink bg-white px-4 py-3.5"><span className="font-serif text-[30px] num">500</span><span className="font-mono">USDC</span></div>
          <div className="flex items-baseline gap-2 text-[15px]"><span>You receive about</span><span className="flex-1 -translate-y-1 border-b border-dotted border-[#A89F8A]" /><span className="font-mono num">436.9 cTWRA</span></div>
          <span className="inline-flex min-h-12 items-center justify-center rounded-[10px] bg-blue font-semibold text-white">Review purchase</span>
        </div>
      </Link>
      <Link to="/launch" className="lp-card flex flex-col gap-6 overflow-hidden rounded-3xl bg-ink p-6 text-paper no-underline hover:text-paper sm:rounded-[28px] sm:p-11">
        <span className={`${kb} text-[#E8B4A8]`}>For issuers</span>
        <h3 className="m-0 font-serif text-[36px] leading-none font-normal sm:text-[52px]">Raise from anyone.<br />Stay compliant.</h3>
        <span className="font-semibold text-[#E8B4A8] sm:hidden">Launch an asset →</span>
        <div aria-hidden="true" className={`${peek} bg-surface text-ink`}>
          <div className="flex items-baseline justify-between"><span className="font-serif text-[26px]">Aegis Tower B</span><span className="font-mono text-xs text-green">Graduated</span></div>
          <div className="flex items-center justify-between border-b border-rule py-3.5"><span>Your raise</span><span className="font-serif text-[26px] num">20,000 <span className="text-[13px] text-mute">USDC</span></span></div>
          <div className="flex items-center justify-between text-sm text-amber"><span>3 holders waiting for approval</span><span className="underline">Review</span></div>
          <span className="inline-flex min-h-12 items-center justify-center rounded-[10px] bg-ink font-semibold text-paper">Collect 10,000 USDC</span>
        </div>
      </Link>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------
// Proof, fees, questions
// ------------------------------------------------------------------------------------------------

function Proof() {
  const id = AEGIS_PROGRAM_ID.toBase58();
  return (
    <section id="proof" className={`${wrap} lp-reveal scroll-mt-28 pt-20 sm:pt-28 lg:pt-36`}>
      <div className="grid items-center gap-8 rounded-3xl bg-ink p-6 text-paper sm:rounded-[32px] sm:p-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-16 lg:p-[72px]">
        <div className="flex flex-col gap-5">
          <span className={`${kb} text-[#E8B4A8]`}>Proof</span>
          <h2 className="m-0 font-serif text-[40px] leading-[0.95] sm:text-[56px] lg:text-[68px]">Don’t trust us.<br />Read the check.</h2>
          <p className="m-0 text-[17px] leading-relaxed text-line">Every instruction that moves either token ends with this check. If the escrow would hold less than the wrappers in existence, the whole transaction fails.</p>
          <div className="mt-3 grid grid-cols-3 gap-4 sm:gap-8">
            {[["270+", "tests, attacks included"], ["Open", "source code"], ["Real", "Meteora in the tests"]].map(([big, small]) => (
              <div key={big} className="flex flex-col gap-1"><span className="font-serif text-[32px] leading-none num sm:text-[44px]">{big}</span><span className="text-[13px] text-line">{small}</span></div>
            ))}
          </div>
        </div>
        <figure className="m-0 min-w-0 overflow-hidden rounded-2xl border border-ink2 bg-[#0E0D0A]">
          <div className="flex items-center justify-between gap-3 border-b border-ink2 px-4 py-3 font-mono text-xs sm:px-[18px]">
            <span className="truncate text-[#A89F8A]">programs/aegis/src/state/launch.rs</span>
            <a href={`${REPO}/blob/main/programs/aegis/src/state/launch.rs#L133-L140`} target="_blank" rel="noopener noreferrer" className="shrink-0 text-[#C9D3F0] hover:text-white">GitHub ↗</a>
          </div>
          <pre className="m-0 overflow-x-auto p-4 font-mono text-[11px] leading-[1.8] text-[#E4DECF] sm:p-6 sm:text-[15px]">
            <span className="text-[#7F786A]">/// The vault must always hold at least</span>{"\n"}
            <span className="text-[#7F786A]">/// as much as there are wrappers.</span>{"\n"}
            <span className="text-[#E8B4A8]">pub fn</span> <span className="text-white">assert_backing</span>(&amp;self) -&gt; Result&lt;()&gt; {"{"}{"\n"}
            {"    "}<span className="text-[#C9D3F0]">require_gte!</span>({"\n"}
            {"        "}self.real_rwa_locked,{"\n"}
            {"        "}self.crwa_minted,{"\n"}
            {"        "}AegisError::<span className="text-[#6FCF97]">BackingShortfall</span>{"\n"}
            {"    "});{"\n"}
            {"    "}Ok(()){"\n"}
            {"}"}
          </pre>
          <a href={explorerUrl("address", id)} target="_blank" rel="noopener noreferrer" className="block border-t border-ink2 px-4 py-3 font-mono text-xs text-[#A89F8A] no-underline hover:text-white sm:px-[18px]">
            Program {id.slice(0, 8)}…{id.slice(-6)} ↗
          </a>
        </figure>
      </div>
    </section>
  );
}

function Fees({ platform }: { platform: ReturnType<typeof usePlatform>["data"] }) {
  const p = platform?.config;
  const fee = p ? p.curveFeeBps / 100 : null;
  const meteora = fee !== null ? (fee * METEORA_PROTOCOL_FEE_PCT) / 100 : 0;
  const issuer = p && fee !== null ? ((fee - meteora) * p.issuerCurveFeeSharePct) / 100 : 0;
  const range = p ? poolFeeRange(p) : null;
  const cards: [string, string, boolean?][] = [
    [p ? `${formatUnits(p.creationFeeLamports, 9, { maxFraction: 3 })} SOL` : "—", "to file a launch"],
    [fee !== null ? pct(fee) : "—", fee !== null ? `per sale trade · ${pct(meteora)} Meteora, ${pct(fee - meteora - issuer)} Aegis${issuer ? `, ${pct(issuer)} issuer` : ""}` : "per sale trade"],
    [range ? `${pct(range.min / 100)}–${pct(range.max / 100)}` : "—", "pool trades, set by the issuer"],
    [p ? `${p.minMigrationFeePct}–${p.maxMigrationFeePct}%` : "—", "of the raise to the issuer, the rest becomes the pool"],
    ["0", "to swap through the bridge", true],
  ];
  return (
    <section id="fees" className={`${wrap} lp-reveal scroll-mt-28 pt-20 sm:pt-28 lg:pt-36`}>
      <div className="flex flex-col justify-between gap-3 pb-8 lg:flex-row lg:items-end">
        <h2 className={`m-0 ${h2}`}>Every fee. Up front.</h2>
        <span className="max-w-[360px] text-sm text-mute lg:text-right">Read live from the program, which also enforces the limits. An open sale’s terms never change.</span>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        {cards.map(([big, small, good], i) => (
          <div key={i} className={`lp-card flex flex-col gap-2.5 rounded-2xl border bg-surface p-5 sm:rounded-[20px] sm:p-6 ${good ? "border-green" : "border-rule"} ${i === 4 ? "max-md:col-span-2" : ""}`}>
            <span className={`font-serif text-[34px] leading-none num sm:text-5xl ${good ? "text-green" : ""}`}>{big}</span>
            <span className="text-sm text-ink2">{small}</span>
          </div>
        ))}
      </div>
      <p className="m-0 pt-6 text-sm text-mute">The issuer keeps the legal powers a security needs: approving holders, freezing, pausing, and court-ordered transfers. <Link to="/registry" className="text-blue underline underline-offset-[3px]">Every asset page discloses them.</Link></p>
    </section>
  );
}

function Questions() {
  const qa: [string, ReactNode][] = [
    ["What does the chain prove, and what doesn’t it?", <>It proves that every wrapper is matched by one unit of the security locked in escrow, that the supply can never grow, and that the sale followed the terms on its page. It can’t see the building, share or loan the security stands for. That link is the issuer’s legal promise, set out in the offering documents each asset page links to.</>],
    ["Why can anyone buy the wrapper?", <>Meteora permanently removes the wrapper’s transfer checks when a sale completes, for every pool. Aegis is built around that instead of pretending otherwise. The wrapper trades freely, like many tokenised stocks do, and the checks sit where the law needs them: on holding the security itself. Only wallets the issuer approved can turn wrappers into the security.</>],
    ["What can the issuer still do?", <>What securities law requires: approve holders, freeze one wallet, pause all transfers, and move tokens under a court order. Every use is public. If the escrow is ever touched, the backing check on every page shows it within seconds, and the bridge never pays out more than the escrow holds.</>],
    ["What if the sale doesn’t fill?", <>It stays open, and while it is, you can sell back to the curve at any time. Before the sale opens, an issuer can withdraw the launch and take the asset back; once anyone has bought, it can’t. When the sale fills, the purchase that fills it opens the permanent pool and the bridge. Nobody has to press a button.</>],
    ["Is this real money?", <>Not yet. Aegis runs on {NETWORK}, and every asset here is a test launch. Nothing on this site is an offer of securities or investment advice.</>],
  ];
  return (
    <section id="questions" className={`${wrap} lp-reveal grid scroll-mt-28 gap-6 pt-20 sm:pt-28 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16 lg:pt-36`}>
      <div className="flex flex-col gap-4">
        <span className={`${kb} text-ox`}>Questions</span>
        <h2 className={`m-0 ${h2}`}>Straight<br className="max-lg:hidden" /> answers.</h2>
      </div>
      <div className="border-t border-ink">
        {qa.map(([q, a]) => (
          <details key={q} className="group border-b border-rule">
            <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-6 py-4 font-serif text-[22px] leading-tight sm:text-[28px] [&::-webkit-details-marker]:hidden">
              {q}
              <span aria-hidden="true" className="relative size-5 shrink-0">
                <span className="absolute top-1/2 left-0 h-[1.5px] w-5 bg-ink" />
                <span className="absolute top-0 left-1/2 h-5 w-[1.5px] bg-ink transition-transform duration-200 group-open:scale-y-0" />
              </span>
            </summary>
            <p className="m-0 max-w-[68ch] pb-6 text-[16px] leading-relaxed text-ink2">{a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className={`${wrap} lp-reveal pt-20 sm:pt-28 lg:pt-36`}>
      <div className="relative flex h-[360px] flex-col items-center justify-center gap-6 overflow-hidden rounded-3xl bg-ox text-center text-paper sm:h-[520px] sm:gap-7 sm:rounded-[32px]">
        <Rosette mono draw={false} className="absolute top-1/2 left-1/2 size-[760px] -translate-x-1/2 -translate-y-1/2 text-paper opacity-20 sm:size-[1100px]" />
        <h2 className="relative m-0 font-serif text-[54px] leading-[0.92] sm:text-[80px] lg:text-[104px]">The registry<br />is open.</h2>
        <div className="relative flex flex-col gap-2.5 sm:flex-row sm:gap-3">
          <Link to="/registry" className={`${pill} bg-paper text-ink no-underline hover:bg-white hover:text-ink`}>Explore the registry</Link>
          <Link to="/launch" className={`${pill} border border-paper text-paper no-underline hover:bg-paper hover:text-ox`}>Launch an asset</Link>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  const link = "text-blue underline-offset-[3px] hover:underline";
  return (
    <footer className={`${wrap} mt-16 sm:mt-20`}>
      <div className="grid gap-6 border-t border-ink py-10 md:grid-cols-[minmax(0,1fr)_auto] md:gap-8">
        <div className="flex max-w-[720px] flex-col gap-2.5">
          <span className="font-serif text-[22px] tracking-[0.08em]">AEGIS</span>
          <p className="m-0 text-[13px] leading-relaxed text-mute">Aegis runs on {NETWORK}. The assets and activity shown are test launches. Nothing here is an offer of securities or investment advice.</p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-3 text-sm">
          <a href={REPO} target="_blank" rel="noopener noreferrer" className={link}>GitHub</a>
          <Link to="/docs" className={link}>Docs</Link>
          <a href={`${REPO}/blob/main/design.md`} target="_blank" rel="noopener noreferrer" className={link}>Design</a>
          <a href={explorerUrl("address", AEGIS_PROGRAM_ID.toBase58())} target="_blank" rel="noopener noreferrer" className={link}>Program</a>
          <Link to="/registry" className={link}>Registry</Link>
        </nav>
      </div>
    </footer>
  );
}

// ------------------------------------------------------------------------------------------------
// Page
// ------------------------------------------------------------------------------------------------

export function LandingPage() {
  const registry = useRegistry();
  const platform = usePlatform();
  const summary = summarize(registry.data);
  const state = registry.data ? "ok" : registry.error instanceof ProgramNotDeployedError ? "absent" : registry.isError ? "error" : "loading";

  useEffect(() => {
    document.title = "Aegis — Real assets, backed one for one";
    document.documentElement.classList.add("scroll-smooth");
    return () => {
      document.title = "Aegis — The Registry";
      document.documentElement.classList.remove("scroll-smooth");
    };
  }, []);

  return (
    <div className="overflow-x-clip bg-paper">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-surface focus:px-4 focus:py-2">Skip to content</a>
      <Banner summary={summary} />
      <Nav />
      <main id="main" tabIndex={-1} className="outline-none">
        <Hero summary={summary} state={state} readAt={registry.dataUpdatedAt} />
        <div className="mt-10 lg:mt-0" />
        <Stats summary={summary} state={state} />
        <Tape summary={summary} />
        <BridgeDemo summary={summary} />
        <Guarantees platform={platform.data} />
        <Stages />
        <Paths />
        <Proof />
        <Fees platform={platform.data} />
        <Questions />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
