import type { LaunchStage } from "../chain/aegis";

export type StageGroup = "open" | "graduated" | "preparing" | "withdrawn";

export const STAGE: Record<LaunchStage, { label: string; group: StageGroup; step?: number; detail: string }> = {
  TokenCreated: { label: "Preparing", group: "preparing", step: 1, detail: "Security filed" },
  Funded: { label: "Preparing", group: "preparing", step: 2, detail: "Asset in escrow" },
  Configured: { label: "Preparing", group: "preparing", step: 3, detail: "Terms set, opening soon" },
  Live: { label: "Offering open", group: "open", detail: "Anyone can buy or sell" },
  Graduated: { label: "Graduated · bridge open", group: "graduated", detail: "Trading on Meteora" },
  Aborted: { label: "Withdrawn", group: "withdrawn", detail: "Cancelled before the sale; asset returned" },
};

/** Registry order: open offerings first, then graduated, then preparing, then withdrawn. */
export const GROUP_ORDER: Record<StageGroup, number> = { open: 0, graduated: 1, preparing: 2, withdrawn: 3 };
