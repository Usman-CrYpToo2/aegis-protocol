/**
 * The documentation, assembled in reading order.
 *
 * Structure follows Diátaxis and the docs of comparable protocols (Meteora, Jupiter Studio,
 * Centrifuge, xStocks): an introduction and a tutorial, then concepts that explain how Aegis
 * works, how-to guides per audience, the trust model, and reference pages to look facts up.
 * Style follows Google's developer guide: second person, present tense, active voice,
 * sentence-case headings, conditions before instructions, on-screen labels in bold exactly as the
 * app shows them. Every claim comes from the program source; platform numbers are read live, and
 * the worked example is computed by the same planner the launch form uses.
 */
import { compliance, escrow, graduation, lifecycle, priceDiscovery, tokens } from "./pages/concepts";
import { buy, launch, manage, redeem, saleTermsGuide } from "./pages/guides";
import { overview, tryIt } from "./pages/intro";
import { addresses, faq, fees, glossary, messages } from "./pages/reference";
import { guarantees, legal, limits, roles } from "./pages/trust";
import type { DocPage } from "./shared";

export { figures } from "./shared";

export const DOC_PAGES: DocPage[] = [
  overview, tryIt,
  priceDiscovery, graduation, tokens, escrow, compliance, lifecycle,
  buy, redeem,
  launch, saleTermsGuide, manage,
  guarantees, limits, roles, legal,
  faq, fees, addresses, messages, glossary,
];
export const DOC_GROUPS = ["Introduction", "How Aegis works", "For investors", "For issuers", "Trust & security", "Reference"] as const;
