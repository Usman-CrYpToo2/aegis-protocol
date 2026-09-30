import { useEffect, useMemo, useRef, useState } from "react";
import type { DbcConfig } from "../../chain/meteora";
import { formatUnits, sqrtPriceToQuoteAtoms } from "../../lib/amount";
import { sampleCurve, walkCurve } from "../../lib/curve";

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

/**
 * The sale's price curve, drawn from the exact segments Meteora will trade on. Only the drawing is
 * floating point; every labelled number comes from the bigint maths.
 */
export function CurveChart({ terms, sqrtNow, finished = false, ceiling, ceilingLabel, baseDecimals, quote, wrapperSymbol }: Props) {
  // Drawn at the real on-screen width, so labels stay at reading size on a phone instead of the
  // whole picture being shrunk.
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

  const model = useMemo(() => {
    const start = terms.sqrtStartPrice;
    const end = terms.migrationSqrtPrice;
    const points = sampleCurve(start, terms.curve, end, baseDecimals);
    const last = points[points.length - 1]!;
    const first = points[0]!;
    const soldNow = sqrtNow === null ? null : walkCurve(start, terms.curve, sqrtNow < end ? sqrtNow : end).base;
    const priceNow = sqrtNow === null ? null : sqrtPriceToQuoteAtoms(sqrtNow, baseDecimals);

    const maxSold = Number(last.sold) || 1;
    const lo = Number(first.price);
    const hi = Math.max(Number(ceiling), Number(last.price));
    const span = hi - lo || 1;
    const x = (sold: bigint) => PAD.left + (Number(sold) / maxSold) * (W - PAD.left - PAD.right);
    const y = (price: bigint | number) => PAD.top + (1 - (Number(price) - lo) / span) * (H - PAD.top - PAD.bottom);

    const line = points.map((p, i) => `${i ? "L" : "M"}${x(p.sold).toFixed(1)} ${y(p.price).toFixed(1)}`).join("");
    const baseline = H - PAD.bottom;
    const filledPts = soldNow === null ? [] : points.filter((p) => p.sold <= soldNow);
    const filled =
      soldNow !== null && priceNow !== null && filledPts.length
        ? `${filledPts.map((p, i) => `${i ? "L" : "M"}${x(p.sold).toFixed(1)} ${y(p.price).toFixed(1)}`).join("")}L${x(soldNow).toFixed(1)} ${y(priceNow).toFixed(1)}L${x(soldNow).toFixed(1)} ${baseline}L${PAD.left} ${baseline}Z`
        : null;

    return { points, first, last, soldNow, priceNow, x, y, line, filled, baseline };
  }, [terms, sqrtNow, ceiling, baseDecimals, W]);

  const fmtPrice = (v: bigint) => formatUnits(v, quote.decimals, { maxFraction: 4, minFraction: 3 });
  const fmtSold = (v: bigint) => formatUnits(v, baseDecimals, { maxFraction: 0 });
  const { first, last, soldNow, priceNow, x, y } = model;

  const summary =
    `Price curve: opens at ${fmtPrice(first.price)} ${quote.symbol} and rises to ${fmtPrice(last.price)} when ${fmtSold(last.sold)} ${wrapperSymbol} are sold, never above the ${ceilingLabel} ceiling of ${fmtPrice(ceiling)}.` +
    (finished
      ? " The sale is complete."
      : soldNow !== null && priceNow !== null
        ? ` ${fmtSold(soldNow)} sold so far; price now ${fmtPrice(priceNow)}.`
        : " The sale has not opened.");

  return (
    <figure className="m-0 flex flex-col gap-3">
      <div ref={box} className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block h-auto max-w-full" role="img" aria-label={summary}>
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
            <text x={PAD.left - 10} y={y(p) + 4} textAnchor="end" fill="#5C574C" style={LABEL}>
              {fmtPrice(p)}
            </text>
          </g>
        ))}
        <text x={PAD.left} y={H - 12} fill="#5C574C" style={LABEL}>0</text>
        <text x={W - PAD.right} y={H - 12} textAnchor="end" fill="#5C574C" style={LABEL}>
          {fmtSold(last.sold)} {wrapperSymbol} sold
        </text>
        {/* sold so far */}
        {model.filled && <path d={model.filled} fill="#E4DECF" />}
        <path d={model.line} fill="none" stroke="#16140F" strokeWidth="2" />
        {/* graduation */}
        <circle cx={x(last.sold)} cy={y(last.price)} r="5" fill="#16140F" />
        <text x={x(last.sold) - 12} y={y(last.price) - 12} textAnchor="end" fill="#16140F" style={LABEL}>
          graduation · {fmtPrice(last.price)}
        </text>
        {/* now */}
        {!finished && soldNow !== null && priceNow !== null && (
          <g>
            <circle cx={x(soldNow)} cy={y(priceNow)} r="6" fill="#FBFAF6" stroke="#1D3A8A" strokeWidth="2" />
            <text x={x(soldNow)} y={y(priceNow) - 14} textAnchor="middle" fill="#1D3A8A" style={LABEL}>
              now · {fmtPrice(priceNow)}
            </text>
          </g>
        )}
      </svg>
      </div>
      <figcaption className="flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-ink2">
        <span className="inline-flex items-center gap-2"><span className="inline-block h-2.5 w-4 bg-track" aria-hidden="true" />Sold so far</span>
        <span className="inline-flex items-center gap-2"><span className="inline-block w-4 border-t-2 border-ink" aria-hidden="true" />Price</span>
        <span className="inline-flex items-center gap-2"><span className="inline-block w-4 border-t-2 border-dashed border-ox" aria-hidden="true" />Price ceiling</span>
      </figcaption>
    </figure>
  );
}
