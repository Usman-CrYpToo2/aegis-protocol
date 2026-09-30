import { useId, useState, type ReactNode } from "react";
import type { AssetDetails } from "../../chain/issue";

const bytes = (s: string) => new TextEncoder().encode(s).length;
const U64_MAX = 18_446_744_073_709_551_615n;

export type AssetDraft = { name: string; symbol: string; supply: string; decimals: number; uri: string };
export const EMPTY_ASSET: AssetDraft = { name: "", symbol: "", supply: "", decimals: 6, uri: "" };

/** The checks create_rwa makes, in the order an issuer fills the form. `null` means valid. */
export function checkAsset(d: AssetDraft): { field: keyof AssetDraft; message: string } | { details: AssetDetails } {
  const name = d.name.trim();
  if (!name) return { field: "name", message: "Give the asset a name." };
  if (bytes(name) > 32) return { field: "name", message: "Use 32 characters or fewer." };
  const symbol = d.symbol.trim();
  if (!/^[A-Z0-9]{1,9}$/.test(symbol)) return { field: "symbol", message: "Use 1 to 9 capital letters or digits, like TWRA." };
  const supply = d.supply.replace(/[,\s_]/g, "");
  if (!/^\d+$/.test(supply) || BigInt(supply) === 0n) return { field: "supply", message: "Enter a whole number of units above zero." };
  const totalSupply = BigInt(supply) * 10n ** BigInt(d.decimals);
  if (totalSupply > U64_MAX) return { field: "supply", message: "That supply is too large for Solana at these decimals." };
  const uri = d.uri.trim();
  if (uri && !/^https:\/\/\S+$/.test(uri)) return { field: "uri", message: "Use a full https:// link, or leave it empty." };
  if (bytes(uri) > 200) return { field: "uri", message: "Use a link of 200 characters or fewer." };
  return { details: { name, symbol, uri, decimals: d.decimals, totalSupply } };
}

function Field({ id, label, hint, error, children }: { id: string; label: string; hint: ReactNode; error?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[15px] font-semibold">{label}</label>
      {children}
      {error ? <span id={`${id}-err`} role="alert" className="text-[13px] text-error">{error}</span> : <span className="text-[13px] leading-relaxed text-mute">{hint}</span>}
    </div>
  );
}

const input = "min-h-12 w-full border border-line bg-surface px-3 text-[15px] outline-none focus:border-ink aria-[invalid=true]:border-error";

export function AssetForm({ draft, onChange, disabled }: { draft: AssetDraft; onChange: (d: AssetDraft) => void; disabled: boolean }) {
  const base = useId();
  const [touched, setTouched] = useState<Partial<Record<keyof AssetDraft, boolean>>>({});
  const check = checkAsset(draft);
  const errorFor = (f: keyof AssetDraft) => ("field" in check && check.field === f && touched[f] ? check.message : undefined);
  const set = <K extends keyof AssetDraft>(k: K, v: AssetDraft[K]) => onChange({ ...draft, [k]: v });
  const blur = (k: keyof AssetDraft) => () => setTouched((t) => ({ ...t, [k]: true }));
  const aria = (k: keyof AssetDraft) => ({ "aria-invalid": Boolean(errorFor(k)), "aria-describedby": errorFor(k) ? `${base}-${k}-err` : undefined });
  const wrapper = draft.symbol.trim() ? `c${draft.symbol.trim()}` : "cXXXX";

  return (
    <fieldset disabled={disabled} className="grid grid-cols-1 gap-6 md:grid-cols-2">
      <legend className="sr-only">The asset</legend>
      <div className="md:col-span-2">
        <Field id={`${base}-name`} label="Name" hint="The legal name buyers will see, like the building or fund. Up to 32 characters." error={errorFor("name")}>
          <input id={`${base}-name`} className={input} value={draft.name} maxLength={40} autoComplete="off" onBlur={blur("name")} onChange={(e) => set("name", e.target.value)} {...aria("name")} placeholder="Aegis Tower A" />
        </Field>
      </div>
      <Field id={`${base}-symbol`} label="Symbol" hint={<>Short ticker for the security. The tradable wrapper becomes <span className="font-mono">{wrapper}</span>.</>} error={errorFor("symbol")}>
        <input id={`${base}-symbol`} className={`${input} font-mono uppercase`} value={draft.symbol} maxLength={9} autoComplete="off" onBlur={blur("symbol")} onChange={(e) => set("symbol", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} {...aria("symbol")} placeholder="TWRA" />
      </Field>
      <Field id={`${base}-supply`} label="Total supply" hint="Every unit that will ever exist. It all goes into escrow; the supply can’t be raised later without everyone seeing." error={errorFor("supply")}>
        <input id={`${base}-supply`} className={`${input} num`} value={draft.supply} inputMode="numeric" autoComplete="off" onBlur={blur("supply")} onChange={(e) => set("supply", e.target.value)} {...aria("supply")} placeholder="1,000,000" />
      </Field>
      <Field id={`${base}-decimals`} label="Decimals" hint="How finely one unit divides. 6 suits most assets; Meteora accepts 6 to 9.">
        <select id={`${base}-decimals`} className={input} value={draft.decimals} onChange={(e) => set("decimals", Number(e.target.value))}>
          {[6, 7, 8, 9].map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </Field>
      <Field id={`${base}-uri`} label="Offering documents (optional)" hint="A link to your prospectus or data room, stored in the token’s metadata." error={errorFor("uri")}>
        <input id={`${base}-uri`} className={input} value={draft.uri} type="url" autoComplete="off" onBlur={blur("uri")} onChange={(e) => set("uri", e.target.value)} {...aria("uri")} placeholder="https://" />
      </Field>
    </fieldset>
  );
}
