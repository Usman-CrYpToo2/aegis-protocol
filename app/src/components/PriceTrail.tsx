import { useMemo } from "react";
import type { RegistryEntry } from "../chain/registry";
import { sqrtPriceToQuoteAtoms } from "../lib/amount";
import { sampleCurve, walkCurve } from "../lib/curve";

const W = 84;
const H = 28;
const PAD = 3;

/**
 * A row-sized chart of the sale's price, for lists. On a bonding curve the price can only move
 * along the curve, so the curve up to the current point is the price's whole path so far: drawn
 * solid in the stage's colour, the rest of the curve faint ahead of it. An open sale's dot sends
 * out a ring each time the registry is read again (`at`); a graduated sale's line is complete.
 * Decorative next to the price, which is given in text.
 */
export function PriceTrail({ entry, at, className = "" }: { entry: RegistryEntry; at: number; className?: string }) {
  const { launch, raise } = entry;
  const terms = entry.detail.terms;
  const graduated = launch.stage === "Graduated" || (launch.stage === "Live" && raise !== null && raise.raised >= raise.target);
  const sqrtNow = graduated ? terms?.migrationSqrtPrice : launch.stage === "Live" ? entry.detail.pool?.sqrtPrice : undefined;

  const model = useMemo(() => {
    if (!terms || sqrtNow === undefined) return null;
    const end = terms.migrationSqrtPrice;
    const points = sampleCurve(terms.sqrtStartPrice, terms.curve, end, launch.decimals, 24);
    const now = sqrtNow < end ? sqrtNow : end;
    const sold = walkCurve(terms.sqrtStartPrice, terms.curve, now).base;
    const price = sqrtPriceToQuoteAtoms(now, launch.decimals);
    const maxSold = Number(points[points.length - 1]!.sold) || 1;
    const lo = Number(points[0]!.price);
    const span = Number(points[points.length - 1]!.price) - lo || 1;
    const x = (s: bigint) => PAD + (Number(s) / maxSold) * (W - PAD * 2);
    const y = (p: bigint) => H - PAD - ((Number(p) - lo) / span) * (H - PAD * 2);
    const path = (pts: { sold: bigint; price: bigint }[]) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.sold).toFixed(1)} ${y(p.price).toFixed(1)}`).join("");
    const done = [...points.filter((p) => p.sold < sold), { sold, price }];
    return { all: path(points), done: path(done), cx: x(sold), cy: y(price) };
  }, [terms, sqrtNow, launch.decimals]);

  if (!model) return null;
  const tone = graduated ? "#1E6B45" : "#1D3A8A";
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" className={`shrink-0 overflow-visible ${className}`}>
      <path d={model.all} fill="none" stroke="#CFC7B5" strokeWidth="1.25" strokeDasharray="2 2.5" />
      <path d={model.done} fill="none" stroke={tone} strokeWidth="1.75" strokeLinecap="round" pathLength={1} className="chart-draw" />
      {!graduated && <circle key={at} cx={model.cx} cy={model.cy} r="2.75" fill={tone} className="beat" />}
      <circle cx={model.cx} cy={model.cy} r="2.75" fill={tone} />
    </svg>
  );
}
