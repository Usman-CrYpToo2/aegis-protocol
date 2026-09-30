import { NavLink } from "react-router-dom";
import { config } from "../config";
import { ProgramNotDeployedError } from "../chain/registry";
import { useRegistry } from "../hooks/useRegistry";
import { LogoMark } from "./Logo";
import { WalletButton } from "./WalletButton";

function NetworkChip() {
  const registry = useRegistry();
  // "Not deployed" is an answer from a working node, so it does not count as offline.
  const offline = registry.isError && !registry.data && !(registry.error instanceof ProgramNotDeployedError);
  const name = config.cluster === "devnet" ? "Devnet" : "Localnet";
  return (
    <span
      className={`inline-flex h-7 items-center gap-1.5 rounded-full border bg-surface px-2 text-xs sm:px-2.5 sm:text-[13px] ${offline ? "border-amber text-amber" : "border-line text-ink2"}`}
      title={offline ? `Can't reach ${config.rpcUrl}` : `Reading from ${config.rpcUrl}`}
    >
      <span className={`size-2 rounded-full ${offline ? "bg-amber" : "bg-green"}`} aria-hidden="true" />
      {name}
      {offline && <span className="sr-only"> (not reachable)</span>}
    </span>
  );
}

const link = ({ isActive }: { isActive: boolean }) =>
  `inline-flex h-18 items-center border-b-2 text-[15px] ${isActive ? "border-ink font-semibold text-ink" : "border-transparent text-mute hover:text-ink"}`;

export function Header() {
  return (
    <header className="border-b border-rule bg-paper">
      <div className="mx-auto flex h-18 max-w-[1440px] items-center justify-between gap-4 px-4 sm:px-8 lg:px-20">
        <div className="flex items-center gap-6 lg:gap-12">
          <NavLink to="/" className="flex items-center gap-3 text-ink no-underline" aria-label="Aegis — the Registry">
            <LogoMark />
            <span className="font-serif text-[26px] tracking-[0.08em]">AEGIS</span>
          </NavLink>
          <nav aria-label="Main" className="hidden gap-8 md:flex">
            <NavLink to="/" end className={link}>
              Registry
            </NavLink>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <NetworkChip />
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
