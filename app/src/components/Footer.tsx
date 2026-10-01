import { Link } from "react-router-dom";
import { explorerUrl } from "../config";
import { AEGIS_PROGRAM_ID } from "../chain/ids";
import { NETWORK_NAME, REPO_URL } from "../lib/site";
import { LogoMark } from "./Logo";

/**
 * The app pages' footer: one calm line with the disclaimer every page of a securities product
 * needs, and the way back to the landing page. On an asset page with the phone buy bar showing,
 * it leaves room so the bar never covers it.
 */
export function Footer() {
  const link = "underline decoration-line underline-offset-2 hover:text-ink";
  return (
    <footer className="border-t border-rule [body:has([data-buybar])_&]:max-md:pb-24">
      <div className="shell flex flex-col gap-3 py-6 text-[13px] text-mute md:flex-row md:items-center md:justify-between md:gap-8">
        <p className="m-0 flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="flex items-center gap-2 text-ink"><LogoMark size={18} /><span className="font-serif text-base tracking-[0.08em]">AEGIS</span></span>
          <span>Runs on {NETWORK_NAME}. Every asset is a test launch. Nothing here is an offer of securities or investment advice.</span>
        </p>
        <nav aria-label="Footer" className="flex shrink-0 gap-5">
          <Link to="/" className={link}>About Aegis</Link>
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className={link}>GitHub ↗</a>
          <a href={explorerUrl("address", AEGIS_PROGRAM_ID.toBase58())} target="_blank" rel="noopener noreferrer" className={link}>Program ↗</a>
        </nav>
      </div>
    </footer>
  );
}
