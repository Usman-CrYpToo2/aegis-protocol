import { useEffect, useState } from "react";
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
      title={offline ? `Can't reach ${config.rpcHost}` : `Reading from ${config.rpcHost}`}
    >
      <span className={`size-2 rounded-full ${offline ? "bg-amber" : "bg-green"}`} aria-hidden="true" />
      {/* On a phone the dot alone carries it; the name stays for screen readers. */}
      <span className="sr-only sm:not-sr-only">{name}</span>
      {offline && <span className="sr-only"> (not reachable)</span>}
    </span>
  );
}

const phoneLink = (active: boolean) => `flex min-h-12 items-center border-b border-rule text-[17px] last:border-b-0 ${active ? "font-semibold text-ink" : "text-ink2"}`;

const link = ({ isActive }: { isActive: boolean }) =>
  `inline-flex h-18 items-center border-b-2 text-[15px] ${isActive ? "border-ink font-semibold text-ink" : "border-transparent text-mute hover:text-ink"}`;

export function Header() {
  const { pathname } = useLocation();
  const console_ = useConsole();
  const attention = console_.attention.length;
  // Asset pages are part of the registry, so its tab stays marked while one is open.
  const inRegistry = pathname === "/registry" || pathname.startsWith("/asset/");
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [pathname]);
  return (
    <header className="border-b border-rule bg-paper">
      {/* The same width and side margins as every page (the shell utility), so the edges line up on any screen. */}
      <div className="shell flex h-18 items-center justify-between gap-4">
        <div className="flex items-center gap-6 lg:gap-12">
          <NavLink to="/" className="flex items-center gap-3 text-ink no-underline" aria-label="Aegis home">
            <LogoMark />
            <span className="font-serif text-[26px] tracking-[0.08em]">AEGIS</span>
          </NavLink>
          <nav aria-label="Main" className="hidden gap-8 md:flex">
            <NavLink to="/registry" className={() => link({ isActive: inRegistry })} aria-current={inRegistry ? "page" : undefined}>
              Registry
            </NavLink>
            {/* Shown before a wallet connects too, so a first visit sees what the app does; each page
                explains itself and offers to connect. */}
            <NavLink to="/holdings" className={link}>
              My holdings
            </NavLink>
            {/* A wallet recorded as some launch's issuer gets the console instead. Anyone else can start one. */}
            {!console_.isIssuer && (
              <NavLink to="/launch" className={link}>
                Launch an asset
              </NavLink>
            )}
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
        <div className="flex items-center gap-2 sm:gap-3">
          {/* From tablet width up these sit in the bar; on a phone they move into the menu. Test money only exists on devnet. */}
          {config.cluster === "devnet" && (
            <NavLink to="/faucet" className={({ isActive }) => `hidden h-11 items-center px-1 text-[15px] md:inline-flex ${isActive ? "font-semibold text-ink underline underline-offset-8" : "text-mute hover:text-ink"}`}>
              Faucet
            </NavLink>
          )}
          <NavLink to="/docs" className={({ isActive }) => `hidden h-11 items-center px-1 text-[15px] md:inline-flex ${isActive ? "font-semibold text-ink underline underline-offset-8" : "text-mute hover:text-ink"}`}>
            Docs
          </NavLink>
          <NetworkChip />
          <WalletButton />
          <button
            type="button"
            onClick={() => setMenu((v) => !v)}
            aria-expanded={menu}
            aria-controls="phone-menu"
            aria-label={menu ? "Close the menu" : "Open the menu"}
            className="inline-flex size-11 cursor-pointer items-center justify-center border border-line bg-surface text-ink hover:border-ink md:hidden"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              {menu ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>
      </div>
      {/* A phone has no room for the main nav in the bar, so it lives here. Closes on any navigation. */}
      {menu && (
        <nav id="phone-menu" aria-label="Main" className="shell flex flex-col border-t border-rule pb-3 md:hidden">
          <NavLink to="/registry" className={() => phoneLink(inRegistry)}>Registry</NavLink>
          <NavLink to="/holdings" className={({ isActive }) => phoneLink(isActive)}>My holdings</NavLink>
          {!console_.isIssuer && <NavLink to="/launch" className={({ isActive }) => phoneLink(isActive)}>Launch an asset</NavLink>}
          {console_.isIssuer && (
            <NavLink to="/console" className={({ isActive }) => phoneLink(isActive)}>
              Issuer console{attention > 0 && <span className="ml-2 font-mono text-[13px] text-amber">{attention} need you</span>}
            </NavLink>
          )}
          {config.cluster === "devnet" && <NavLink to="/faucet" className={({ isActive }) => phoneLink(isActive)}>Faucet</NavLink>}
          <NavLink to="/docs" className={({ isActive }) => phoneLink(isActive)}>Docs</NavLink>
        </nav>
      )}
    </header>
  );
}
