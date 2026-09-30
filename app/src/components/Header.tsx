import { useWallet } from "@solana/wallet-adapter-react";
import { NavLink, useLocation } from "react-router-dom";
import { config } from "../config";
import { ProgramNotDeployedError } from "../chain/registry";
import { useRegistry } from "../hooks/useRegistry";
import { useConsole } from "../hooks/useConsole";
import { LogoMark } from "./Logo";
import { WalletButton } from "./WalletButton";

function NetworkChip() {
  const registry = useRegistry();
  // "Not deployed" is an answer from a working node, so it does not count as offline.
  const offline = registry.isError && !registry.data && !(registry.error instanceof ProgramNotDeployedError);
  const name = config.cluster === "devnet" ? "Devnet" : "Localnet";
  return (
    <span
      className={`inline-flex h-7 min-w-7 items-center justify-center gap-1.5 rounded-full border bg-surface px-2 text-xs sm:px-2.5 sm:text-[13px] ${offline ? "border-amber text-amber" : "border-line text-ink2"}`}
      title={offline ? `Can't reach ${config.rpcUrl}` : `Reading from ${config.rpcUrl}`}
    >
      <span className={`size-2 rounded-full ${offline ? "bg-amber" : "bg-green"}`} aria-hidden="true" />
      {/* On a phone the dot alone carries it; the name stays for screen readers. */}
      <span className="sr-only sm:not-sr-only">{name}</span>
      {offline && <span className="sr-only"> (not reachable)</span>}
    </span>
  );
}

const link = ({ isActive }: { isActive: boolean }) =>
  `inline-flex h-18 items-center border-b-2 text-[15px] ${isActive ? "border-ink font-semibold text-ink" : "border-transparent text-mute hover:text-ink"}`;

export function Header() {
  const { pathname } = useLocation();
  const { publicKey } = useWallet();
  const console_ = useConsole();
  const attention = console_.attention.length;
  // Asset pages are part of the registry, so its tab stays marked while one is open.
  const inRegistry = pathname === "/" || pathname.startsWith("/asset/");
  return (
    <header className="border-b border-rule bg-paper">
      <div className="flex h-18 w-full items-center justify-between gap-4 px-4 sm:px-6 lg:px-10 2xl:px-14">
        <div className="flex items-center gap-6 lg:gap-12">
          <NavLink to="/" className="flex items-center gap-3 text-ink no-underline" aria-label="Aegis — the Registry">
            <LogoMark />
            <span className="font-serif text-[26px] tracking-[0.08em]">AEGIS</span>
          </NavLink>
          <nav aria-label="Main" className="hidden gap-8 md:flex">
            <NavLink to="/" className={() => link({ isActive: inRegistry })} aria-current={inRegistry ? "page" : undefined}>
              Registry
            </NavLink>
            {publicKey && (
              <NavLink to="/holdings" className={link}>
                My holdings
              </NavLink>
            )}
            {/* Only a wallet recorded as some launch's issuer sees the console. */}
            {console_.isIssuer && (
              <NavLink to="/console" className={link}>
                Issuer console
                {attention > 0 && (
                  <span className="ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber px-1.5 font-mono text-[11px] text-white" aria-label={`${attention} items need attention`}>
                    {attention}
                  </span>
                )}
              </NavLink>
            )}
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
