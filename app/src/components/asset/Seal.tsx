import type { Backing } from "../../chain/backing";
import { formatUnits } from "../../lib/amount";

/**
 * The backing seal. Its colour and words come from the same verdict the registry uses, so it can
 * never look reassuring when the numbers are not.
 */
export function Seal({ backing, decimals, id }: { backing: Backing; decimals: number; id: string }) {
  const fmt = (v: bigint) => formatUnits(v, decimals, { maxFraction: 0 });
  const tone =
    backing.kind === "short" ? "#A3261B" : backing.kind === "unknown" ? "#8A5A00" : backing.kind === "withdrawn" || backing.kind === "not-funded" ? "#5C574C" : "#7E2A1E";

  let big = "1:1";
  let lines: string[] = [];
  let ring = "BACKED ONE-FOR-ONE · VERIFIED ON-CHAIN · AEGIS REGISTRY ·";
  let label = "";
  switch (backing.kind) {
    case "backed":
      lines = [`${fmt(backing.escrowed)} in escrow`, `${fmt(backing.circulating)} in circulation`];
      label = `Backed: ${lines.join(", ")}`;
      break;
    case "escrowed":
      lines = [`${fmt(backing.escrowed)} in escrow`, "wrapper not issued yet"];
      label = `Fully escrowed: ${lines[0]}`;
      break;
    case "short":
      big = "short";
      ring = "BACKING SHORT · THE BRIDGE HAS STOPPED · AEGIS REGISTRY ·";
      lines = [`${fmt(backing.escrowed)} in escrow`, `${fmt(backing.required)} required`];
      label = `Backing short: ${lines.join(", ")}`;
      break;
    case "unknown":
      big = "?";
      ring = "BACKING NOT VERIFIED · READ FAILED · AEGIS REGISTRY ·";
      lines = ["couldn’t read", backing.reason];
      label = `Backing could not be verified: ${backing.reason}`;
      break;
    case "not-funded":
      big = "—";
      ring = "NOT YET FUNDED · NOTHING IN ESCROW · AEGIS REGISTRY ·";
      lines = ["nothing in escrow yet"];
      label = "Not funded yet";
      break;
    case "withdrawn":
      big = "—";
      ring = "WITHDRAWN · ASSET RETURNED · AEGIS REGISTRY ·";
      lines = ["returned to issuer"];
      label = "Withdrawn before sale";
      break;
  }

  return (
    <svg width="260" height="260" viewBox="0 0 280 280" role="img" aria-label={label} className="max-w-full">
      <defs>
        <path id={id} d="M140,140 m-112,0 a112,112 0 1,1 224,0 a112,112 0 1,1 -224,0" />
      </defs>
      <circle cx="140" cy="140" r="134" fill="none" stroke={tone} strokeWidth="2" />
      <circle cx="140" cy="140" r="126" fill="none" stroke={tone} strokeWidth="0.75" />
      <circle cx="140" cy="140" r="96" fill="#FBFAF6" stroke={tone} strokeWidth="0.75" />
      <text style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 11.5, letterSpacing: 3.2 }} fill={tone}>
        <textPath href={`#${id}`}>{ring}</textPath>
      </text>
      <text x="140" y={lines.length > 1 ? 138 : 150} textAnchor="middle" style={{ fontFamily: "Instrument Serif, Georgia, serif", fontSize: big.length > 3 ? 46 : 64 }} fill={backing.kind === "short" ? tone : "#16140F"}>
        {big}
      </text>
      {lines.map((l, i) => (
        <text key={l} x="140" y={166 + i * 18} textAnchor="middle" style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 11 }} fill="#5C574C">
          {l.length > 26 ? `${l.slice(0, 25)}…` : l}
        </text>
      ))}
    </svg>
  );
}
