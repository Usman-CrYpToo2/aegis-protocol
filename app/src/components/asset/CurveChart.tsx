import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { DbcConfig } from "../../chain/meteora";
import { formatUnits, sqrtPriceToQuoteAtoms } from "../../lib/amount";
import { sampleCurve, sqrtAtSold, walkCurve } from "../../lib/curve";

type Props = {
  terms: DbcConfig;
  /** Current sqrt price, or null before the sale opens. */
  sqrtNow: bigint | null;
  /** The sale is over: the whole curve is sold and there is no "now" to mark. */
  finished?: boolean;
  ceiling: bigint;
  ceilingLabel: string;
  baseDecimals: number;
  quote: { symbol: string; decimals: number };
  wrapperSymbol: string;
};

const H = 300;
const LABEL = { font: "11px IBM Plex Mono, monospace", paintOrder: "stroke", stroke: "#FBFAF6", strokeWidth: 4, strokeLinejoin: "round" } as const;
const PAD = { left: 56, right: 24, top: 36, bottom: 36 };
/** Arrow keys move the cursor by this fraction of the curve. */
const KEY_STEPS = 40;

/**
 * The sale's price curve, drawn from the exact segments Meteora trades on, and explorable: point
 * anywhere (mouse, finger or arrow keys) to see the price there and what it would take to get
 * there from now. Only the drawing uses floating point; every number shown comes from bigint maths.
 */
export function CurveChart({ terms, sqrtNow, finished = false, ceiling, ceilingLabel, baseDecimals, quote, wrapperSymbol }: Props) {
  // Drawn at the real on-screen width, so labels stay at reading size on a phone.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(800);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([e]) => setW(Math.max(300, Math.round(e!.contentRect.width))));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const narrow = W < 560;
  const helpId = useId();

  const model = useMemo(() => {
    const start = terms.sqrtStartPrice;
    const end = terms.migrationSqrtPrice;
    const points = sampleCurve(start, terms.curve, end, baseDecimals, 64);
    const last = points[points.length - 1]!;
    const first = points[0]!;
    const nowSqrt = sqrtNow === null ? null : sqrtNow < end ? sqrtNow : end;
    const walkedNow = nowSqrt === null ? null : walkCurve(start, terms.curve, nowSqrt);
    const soldNow = walkedNow?.base ?? null;
    const priceNow = nowSqrt === null ? null : sqrtPriceToQuoteAtoms(nowSqrt, baseDecimals);

    const plotW = W - PAD.left - PAD.right;
    const maxSold = Number(last.sold) || 1;
    const lo = Number(first.price);
    const hi = Math.max(Number(ceiling), Number(last.price));
    const span = hi - lo || 1;
    const x = (sold: bigint) => PAD.left + (Number(sold) / maxSold) * plotW;
    const y = (price: bigint | number) => PAD.top + (1 - (Number(price) - lo) / span) * (H - PAD.top - PAD.bottom);
    const soldAtX = (px: number) => {
      const f = Math.min(1, Math.max(0, (px - PAD.left) / plotW));
      return BigInt(Math.round(f * maxSold));
    };

    const path = (pts: { sold: bigint; price: bigint }[]) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.sold).toFixed(1)} ${y(p.price).toFixed(1)}`).join("");
    const baseline = H - PAD.bottom;
    const filledPts = soldNow === null ? [] : points.filter((p) => p.sold <= soldNow);
    const filled =
      soldNow !== null && priceNow !== null && filledPts.length
        ? `${path(filledPts)}L${x(soldNow).toFixed(1)} ${y(priceNow).toFixed(1)}L${x(soldNow).toFixed(1)} ${baseline}L${PAD.left} ${baseline}Z`
        : null;

    return { start, points, first, last, soldNow, priceNow, quoteNow: walkedNow?.quote ?? null, x, y, soldAtX, line: path(points), filled, baseline, maxSold };
  }, [terms, sqrtNow, ceiling, baseDecimals, W]);

  const { first, last, soldNow, priceNow, x, y } = model;
  const fmtPrice = (v: bigint) => formatUnits(v, quote.decimals, { maxFraction: 4, minFraction: 3 });
  const fmtSold = (v: bigint) => formatUnits(v, baseDecimals, { maxFraction: 0 });
  const fmtQuote = (v: bigint) => formatUnits(v, quote.decimals, { maxFraction: 2 });

  // ---------------------------------------------------------------------------------------------
  // The cursor, in wrapper atoms sold. Null when nobody is exploring.
  // ---------------------------------------------------------------------------------------------
  const [cursor, setCursor] = useState<bigint | null>(null);

  const readout = useMemo(() => {
    if (cursor === null) return null;
    const sold = cursor > last.sold ? last.sold : cursor;
    const sqrt = sqrtAtSold(model.start, terms.curve, sold);
    const price = sqrtPriceToQuoteAtoms(sqrt, baseDecimals);
    const quoteToHere = walkCurve(model.start, terms.curve, sqrt).quote;
    // Meteora takes the fee from the quote paid in, so to land `net` in the curve a buyer pays
    // net / (1 - fee). Rounded up: an estimate that errs towards "a little more".
    const withFee = (net: bigint) => {
      const keep = 10_000n - BigInt(terms.curveFeeBps);
      return keep > 0n ? (net * 10_000n + keep - 1n) / keep : net;
    };

    let detail: string;
    if (finished) detail = "Sold during the sale.";
    else if (soldNow === null || model.quoteNow === null) detail = `Buying from the opening to here: ≈ ${fmtQuote(withFee(quoteToHere))} ${quote.symbol}, fee included.`;
    else if (sold <= soldNow) detail = "Already sold. The price has moved past this point.";
    else detail = `To push the price here from now: buy ≈ ${fmtSold(sold - soldNow)} ${wrapperSymbol} for ≈ ${fmtQuote(withFee(quoteToHere - model.quoteNow))} ${quote.symbol}, fee included.`;

    return { sold, price, detail, ahead: soldNow !== null && sold > soldNow && !finished };
  }, [cursor, model, terms, baseDecimals, soldNow, finished, last.sold, quote.symbol, wrapperSymbol]);

  const onPointer = (e: PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setCursor(model.soldAtX(((e.clientX - rect.left) / rect.width) * W));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = BigInt(Math.max(1, Math.round(model.maxSold / KEY_STEPS)));
    const from = cursor ?? soldNow ?? 0n;
    const clamp = (v: bigint) => (v < 0n ? 0n : v > last.sold ? last.sold : v);
    const moves: Record<string, bigint | null> = {
      ArrowRight: clamp(from + step),
      ArrowUp: clamp(from + step),
      ArrowLeft: clamp(from - step),
      ArrowDown: clamp(from - step),
      Home: 0n,
      End: last.sold,
      Escape: null,
    };
    if (!(e.key in moves)) return;
    e.preventDefault();
    setCursor(moves[e.key]!);
  };

  const summary =
    `Price curve: opens at ${fmtPrice(first.price)} ${quote.symbol} and rises to ${fmtPrice(last.price)} when ${fmtSold(last.sold)} ${wrapperSymbol} are sold, never above the ${ceilingLabel} ceiling of ${fmtPrice(ceiling)}.` +
    (finished ? " The sale is complete." : soldNow !== null && priceNow !== null ? ` ${fmtSold(soldNow)} sold so far; price now ${fmtPrice(priceNow)}.` : " The sale has not opened.");

  const cx = readout ? x(readout.sold) : 0;
  const cy = readout ? y(readout.price) : 0;
  // Keep the tooltip inside the chart: flip to the left of the cursor near the right edge.
  const tipLeft = readout ? Math.min(Math.max(cx, 8), W - 8) : 0;
  const tipFlip = readout ? cx > W * 0.6 : false;

  return (
    <figure className="m-0 flex flex-col gap-3">
      <div
        ref={box}
        tabIndex={0}
        role="group"
        aria-label={summary}
        aria-describedby={helpId}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={(e) => e.pointerType === "mouse" && setCursor(null)}
        onKeyDown={onKey}
        onBlur={() => setCursor(null)}
        className="relative w-full cursor-crosshair touch-pan-y select-none outline-none focus-visible:ring-2 focus-visible:ring-blue focus-visible:ring-offset-4 focus-visible:ring-offset-surface"
      >
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block h-auto max-w-full" aria-hidden="true">
          {/* ceiling */}
          <line x1={PAD.left} x2={W - PAD.right} y1={y(ceiling)} y2={y(ceiling)} stroke="#7E2A1E" strokeWidth="1.5" strokeDasharray="6 5" />
          <text x={W - PAD.right} y={y(ceiling) - 8} textAnchor="end" fill="#7E2A1E" style={LABEL}>
            {narrow ? `ceiling · ${fmtPrice(ceiling)}` : `Ceiling for ${ceilingLabel} · ${fmtPrice(ceiling)} — the curve can never pass this`}
          </text>
          {/* axes */}
          <line x1={PAD.left} x2={W - PAD.right} y1={model.baseline} y2={model.baseline} stroke="#16140F" />
          {[first.price, last.price].map((p) => (
            <g key={p.toString()}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(p)} y2={y(p)} stroke="#E4DECF" />
              <text x={PAD.left - 10} y={y(p) + 4} textAnchor="end" fill="#5C574C" style={LABEL}>{fmtPrice(p)}</text>
            </g>
          ))}
          <text x={PAD.left} y={H - 12} fill="#5C574C" style={LABEL}>0</text>
          <text x={W - PAD.right} y={H - 12} textAnchor="end" fill="#5C574C" style={LABEL}>{fmtSold(last.sold)} {wrapperSymbol} sold</text>

          {/* sold so far, revealed left to right on first paint */}
          {model.filled && <path d={model.filled} fill="#E4DECF" className="chart-reveal" />}
          {/* what the cursor would add, from now to the cursor */}
          {readout?.ahead && soldNow !== null && priceNow !== null && (
            <path
              d={`M${x(soldNow)} ${model.baseline}L${x(soldNow)} ${y(priceNow)}${model.points
                .filter((p) => p.sold > soldNow && p.sold < readout.sold)
                .map((p) => `L${x(p.sold).toFixed(1)} ${y(p.price).toFixed(1)}`)
                .join("")}L${cx} ${cy}L${cx} ${model.baseline}Z`}
              fill="#1D3A8A"
              fillOpacity="0.14"
            />
          )}
          <path d={model.line} fill="none" stroke="#16140F" strokeWidth="2" pathLength={1} className="chart-draw" />

          {/* graduation */}
          <circle cx={x(last.sold)} cy={y(last.price)} r="5" fill="#16140F" />
          <text x={x(last.sold) - 12} y={y(last.price) - 12} textAnchor="end" fill="#16140F" style={LABEL}>graduation · {fmtPrice(last.price)}</text>

          {/* now, with a slow ring that says "this is live" */}
          {!finished && soldNow !== null && priceNow !== null && (
            <g>
              <circle cx={x(soldNow)} cy={y(priceNow)} r="6" fill="none" stroke="#1D3A8A" strokeWidth="2" className="chart-ping" />
              <circle cx={x(soldNow)} cy={y(priceNow)} r="6" fill="#FBFAF6" stroke="#1D3A8A" strokeWidth="2" />
              {!readout && (
                <text x={x(soldNow)} y={y(priceNow) - 14} textAnchor="middle" fill="#1D3A8A" style={LABEL}>now · {fmtPrice(priceNow)}</text>
              )}
            </g>
          )}

          {/* cursor */}
          {readout && (
            <g>
              <line x1={cx} x2={cx} y1={PAD.top - 8} y2={model.baseline} stroke="#16140F" strokeOpacity="0.35" strokeDasharray="3 3" />
              <circle cx={cx} cy={cy} r="5" fill="#16140F" stroke="#FBFAF6" strokeWidth="2" />
            </g>
          )}
        </svg>

        {readout && (
          <div
            className="pointer-events-none absolute top-2 z-10 w-64 max-w-[80%] border border-ink bg-surface p-3 text-left shadow-[0_8px_24px_rgb(22_20_15/0.12)]"
            style={{ left: tipLeft, transform: tipFlip ? "translateX(calc(-100% - 12px))" : "translateX(12px)" }}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-serif text-2xl leading-none num">{fmtPrice(readout.price)}</span>
              <span className="font-mono text-xs text-mute">{quote.symbol}</span>
            </div>
            <div className="mt-1 font-mono text-xs text-mute num">{fmtSold(readout.sold)} {wrapperSymbol} sold by here</div>
            <div className={`mt-2 border-t border-rule pt-2 text-[13px] leading-snug ${readout.ahead ? "text-blue" : "text-ink2"}`}>{readout.detail}</div>
          </div>
        )}
      </div>

      {/* The same readout for screen readers, announced as the cursor moves. */}
      <p className="sr-only" aria-live="polite">
        {readout ? `Price ${fmtPrice(readout.price)} ${quote.symbol} after ${fmtSold(readout.sold)} sold. ${readout.detail}` : ""}
      </p>

      <figcaption className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-[13px] text-ink2">
        <span className="flex flex-wrap gap-x-6 gap-y-1">
          <span className="inline-flex items-center gap-2"><span className="inline-block h-2.5 w-4 bg-track" aria-hidden="true" />Sold so far</span>
          <span className="inline-flex items-center gap-2"><span className="inline-block w-4 border-t-2 border-ink" aria-hidden="true" />Price</span>
          <span className="inline-flex items-center gap-2"><span className="inline-block w-4 border-t-2 border-dashed border-ox" aria-hidden="true" />Price ceiling</span>
        </span>
        <span id={helpId} className="text-mute">Point or tap anywhere on the curve to see the price there{finished ? "" : " and what it takes to get there"}. Arrow keys work too.</span>
      </figcaption>
    </figure>
  );
}
