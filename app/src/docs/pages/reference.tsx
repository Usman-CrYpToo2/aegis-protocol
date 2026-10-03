import type { ReactNode } from "react";
import { AEGIS_HOOK_PROGRAM_ID, AEGIS_PROGRAM_ID, ACCESS_CONTROL_PROGRAM_ID, METEORA_DBC_PROGRAM_ID, TRANSFER_RESTRICTIONS_PROGRAM_ID } from "../../chain/ids";
import { DAMM_V2_PROGRAM_ID } from "../../chain/damm";
import { FAUCET_PROGRAM_ID } from "../../chain/faucet";
import { platformConfigAddress } from "../../chain/platform";
import { config } from "../../config";
import { NETWORK_NAME, REPO_URL } from "../../lib/site";
import { Addr, gradDeposit, type DocPage } from "../shared";
import { Callout, Code, DocLink, Ext, Faq, H2, Lede, P, Table, Terms, UI } from "../ui";

const GROUP = "Reference";

export const faq: DocPage = {
  slug: "faq",
  group: GROUP,
  title: "Questions and answers",
  summary: "Short answers to the questions people ask most, for investors and for issuers.",
  body: (f) => (
    <>
      <Lede>Short answers, with links to the page that explains each one in full.</Lede>
      <H2 id="general">About Aegis</H2>
      <Faq items={[
        ["Why sell a real-world asset on a bonding curve?", <>Because the curve discovers the price in public: every buyer sees the same formula and every order fills at once, with no allocation behind closed doors. The issuer doesn’t need to put up money to start a market. See <DocLink to="/docs/price-discovery">Price discovery on the curve</DocLink>.</>],
        ["What happens when a sale fills?", <>It graduates: the raise and matching wrappers move into a permanent Meteora pool that opens at the sale’s final price, the unsold wrappers are burned and the bridge opens. See <DocLink to="/docs/graduation">Graduation to the pool</DocLink>.</>],
        ["Is any of this real money?", <>Not yet. Aegis runs on {NETWORK_NAME}, and every asset is a test launch.</>],
        ...(config.cluster === "devnet" ? [["Where do I get test money?", <>On the <DocLink to="/faucet">Faucet</DocLink> page: SOL for network fees, and test USDC to buy with. Both are free and have no value.</>] as [string, ReactNode]] : []),
      ]} />
      <H2 id="investors">For investors</H2>
      <Faq items={[
        ["Do I need to pass KYC to buy?", "No. Anyone can buy and trade the wrapper. You need the issuer’s approval only to hold the security itself: to redeem wrappers for it, or to deposit it."],
        ["What do I own when I hold the wrapper?", <>A token backed one for one by the security in the escrow, which an approved holder can redeem for it. What the security entitles you to is set out in the issuer’s offering documents. See <DocLink to="/docs/legal">Legal model</DocLink>.</>],
        ["Why does the price go up as people buy?", <>That is how the curve discovers the price: each purchase moves it up the curve, each sale moves it down, up to a ceiling fixed before the sale. See <DocLink to="/docs/price-discovery#how-price-moves">How the price moves</DocLink>.</>],
        ["Can I sell before the sale ends?", "Yes. While the sale is open you can sell back to the curve at its current price, minus the fee."],
        ["Can I pay with SOL?", <>Yes, on a sale priced in SOL. You pay from your SOL directly; the app wraps what the purchase needs and returns anything unspent as SOL. See <DocLink to="/docs/buy#sol">Paying in SOL</DocLink>.</>],
        ["What if the sale never fills?", "It stays open with no deadline. You can keep trading on the curve, and the issuer can’t take the security back once anyone holds a wrapper."],
        ["Can the issuer take or freeze my wrapper?", <>No. Nobody can freeze the wrapper, and only the Aegis program can mint it. The issuer’s powers apply to the security, including the escrow; if they ever touch the escrow, every page shows it. See <DocLink to="/docs/limits#issuer-powers">Risks and limits</DocLink>.</>],
        ["Is there a fee to redeem?", "No. Redeeming and depositing are one for one, with no fee and no price impact."],
        ["Where do I trade after the sale?", "On the wrapper’s permanent Meteora pool. The asset page links to it."],
      ]} />
      <H2 id="issuers">For issuers</H2>
      <Faq items={[
        ["What does a launch cost?", `${f.creationFee}, plus under 0.1 SOL that Solana holds as deposits for the new accounts. Graduation deposits, about ${gradDeposit} SOL, are paid by whoever graduates the sale.`],
        ["Do I need to provide liquidity?", "No. The buyers’ payments form the curve, and the pool is built from the raise at graduation."],
        ["When do I get my money?", <>At graduation, your cash share of the raise is ready to collect in your console. Pool trading fees and released pool liquidity are collected on Meteora’s site. See <DocLink to="/docs/manage#collect">Collect your money</DocLink>.</>],
        ["Can I change my terms after launching?", "Not once the terms are fixed. Before the sale opens you can cancel the launch, take the security back and start again."],
        ["What happens to the units nobody buys?", "The matching wrappers are burned at graduation. The security behind them stays in the escrow, owed to you, and you collect it in your console once your wallet is on the register."],
        ["Who checks my investors’ identity?", "You do, in your own process. Aegis only enforces your decision on chain."],
        ["Can I issue more of the security later?", "Raising the supply cap is your action in Upside, and it is public. It stops a sale from opening, but never stops your holders from redeeming."],
      ]} />
    </>
  ),
};

export const fees: DocPage = {
  slug: "fees",
  group: GROUP,
  title: "Fees",
  summary: "Every fee in a launch, who pays it and who receives it.",
  body: (f) => (
    <>
      <Lede>Every fee, read live from the program. An open sale’s fees never change.</Lede>
      {!f.live && <Callout kind="warn">The live platform settings couldn’t be read, so these are the program’s defaults.</Callout>}
      <Table
        caption="Fees"
        head={["Fee", "Amount", "Paid by", "Goes to"]}
        rows={[
          ["Launch fee", f.creationFee, "The issuer, once", "Aegis"],
          ["Sale trade fee", `${f.saleFee} of each trade`, "Buyers and sellers on the curve", `${f.meteoraCut} to Meteora, ${f.aegisCut} to Aegis${f.issuerCut ? `, ${f.issuerCut} to the issuer` : ""}`],
          ["Migration fee", "0.2% of the pool’s liquidity", "Taken once, at graduation", "Meteora"],
          ["Pool trade fee", f.poolFee, "Traders in the permanent pool", "The pool’s owners, Aegis and the issuer, by their shares, under Meteora’s pool rules"],
          ["Bridge", "None", "—", "—"],
          ["Account deposits", `Under 0.1 SOL to launch; about ${gradDeposit} SOL to graduate`, "Whoever creates the accounts", "Held by Solana as rent"],
        ]}
      />
      <P>The issuer’s cash share of the raise isn’t a fee. It is the money the sale raises for them: {f.cash} of the target.</P>
    </>
  ),
};

export const addresses: DocPage = {
  slug: "addresses",
  group: GROUP,
  title: "Programs and addresses",
  summary: "Every program a launch touches, with links to check each one in the explorer.",
  body: (f) => (
    <>
      <Lede>The programs a launch touches, on {NETWORK_NAME}. Each address opens in the explorer.</Lede>
      <Table
        caption="Program addresses"
        head={["Program", "Address", "Role"]}
        rows={[
          ["Aegis", <Addr id={AEGIS_PROGRAM_ID.toBase58()} />, "Launch rules, escrow, backing checks and the bridge"],
          ["Aegis hook", <Addr id={AEGIS_HOOK_PROGRAM_ID.toBase58()} />, "Approves every wrapper transfer during the sale. Meteora only gives mint rights to a partner on a pool with a hook."],
          ["Meteora Dynamic Bonding Curve", <Addr id={METEORA_DBC_PROGRAM_ID.toBase58()} />, "The sale"],
          ["Meteora DAMM v2", <Addr id={DAMM_V2_PROGRAM_ID.toBase58()} />, "The permanent pool"],
          ["Upside Transfer Restrictions", <Addr id={TRANSFER_RESTRICTIONS_PROGRAM_ID.toBase58()} />, "The security’s register and transfer rules"],
          ["Upside Access Control", <Addr id={ACCESS_CONTROL_PROGRAM_ID.toBase58()} />, "The issuer’s roles, minting, freezing and the supply cap"],
          ...(config.cluster === "devnet" ? [["Aegis devnet faucet", <Addr id={FAUCET_PROGRAM_ID.toBase58()} />, "Mints free test currencies on devnet. Not part of the protocol: the Aegis program never calls it."]] : []),
        ]}
      />
      <H2 id="currencies">Approved currencies</H2>
      <P>The currencies a sale can be priced in, read live from the platform. The admin approves each one, and only tokens Meteora accepts can be approved.</P>
      <Table
        caption="Approved currencies"
        head={["Currency", "Mint", "Minimum raise"]}
        rows={f.quotes.length ? f.quotes.map((q) => [q.symbol, <Addr id={q.mint} />, `${q.minRaise} ${q.symbol}`]) : [["None readable right now", "", ""]]}
      />
      <H2 id="accounts">Accounts</H2>
      <Table
        caption="Accounts"
        head={["Account", "Where", "What it holds"]}
        rows={[
          ["Platform settings", <Addr id={platformConfigAddress().toBase58()} />, "Fees and limits for new launches"],
          ["Launch record", <>Seeds <Code>launch</Code> + the security’s mint</>, "The stage, both mints, the escrow and the backing ledger. One per security."],
          ["Aegis authority", <>Seeds <Code>authority</Code> + the launch</>, "Owns the escrow and holds the wrapper’s mint rights. No data and no private key."],
          ["Escrow", "The security’s token account owned by the Aegis authority", "The security behind every wrapper"],
        ]}
      />
      <P>The full design, with every instruction and invariant, is in <Ext href={`${REPO_URL}/blob/main/design.md`}>design.md</Ext>. The code is on <Ext href={REPO_URL}>GitHub</Ext>.</P>
    </>
  ),
};

export const messages: DocPage = {
  slug: "messages",
  group: GROUP,
  title: "Messages you might see",
  summary: "What the app’s warnings and the program’s refusals mean, and what to do.",
  body: () => (
    <>
      <Lede>When the program refuses something, the app explains it in plain words. These are the ones you are most likely to meet.</Lede>
      <Table
        caption="Common messages"
        head={["Message", "What it means", "What to do"]}
        rows={[
          ["Your wallet isn’t approved yet", <>The program read the register, and your wallet isn’t in the Investors group (<Code>HolderNotApproved</Code>).</>, "Send your address to the issuer and ask for approval. You can still trade the wrapper."],
          ["The issuer has paused transfers", <>A regulatory hold on the security (<Code>TransfersPaused</Code>).</>, "Wait for the issuer to resume. The wrapper still trades."],
          ["The escrow is short", <>The escrow holds less than the wrappers in circulation (<Code>BackingShortfall</Code>).</>, "The bridge stops for everyone until the escrow is whole. Contact the issuer."],
          ["The escrow is unavailable; exchanges are stopped for everyone", "The issuer changed a setting the bridge needs: the escrow was frozen, or the redemption rule was closed.", "Only the issuer can fix it. The wrapper still trades."],
          ["The price moved before your trade landed", "The price passed your limit, so the trade was cancelled. Nothing was spent.", "Check the new price and try again."],
          ["This sale has just filled", "Someone else’s purchase completed the sale first.", "Graduate it, then trade on its pool."],
          ["This wallet can’t change the register", "The connected wallet doesn’t hold the issuer’s role for this security.", "Switch to the issuer’s wallet."],
          ["Your supply is too small for these terms", "At this opening price, the raise needs more units than you are issuing.", "Raise the price, lower the raise, or issue more."],
          ["Not enough SOL. You can spend up to …", "On a sale priced in SOL, the amount is more than your SOL and wrapped SOL, after keeping back the network fee and deposits.", <>Enter less, or select <UI>Max</UI>. On devnet, get more from the Faucet.</>],
          ["Keep a little more SOL for the network fee", "Your wrapped SOL covers the purchase, but your wallet doesn’t have the SOL the transaction itself needs.", "Add a little SOL to your wallet."],
        ]}
      />
    </>
  ),
};

export const glossary: DocPage = {
  slug: "glossary",
  group: GROUP,
  title: "Glossary",
  summary: "The words used across Aegis, in plain language.",
  body: () => (
    <>
      <Lede>The words used across Aegis and these docs, in plain language.</Lede>
      <Terms items={[
        ["Approved holder", "A wallet the issuer put on the security’s register, in the Investors group, after its own identity checks."],
        ["Bonding curve", "A price set by a formula instead of an order book: it rises as people buy and falls as they sell. Meteora runs it."],
        ["Bridge", "Swapping the wrapper for the security, or back, one for one, after graduation."],
        ["Cash share", "The part of the raise the issuer takes as cash at graduation. The rest becomes the pool."],
        ["Ceiling", "The most a sale’s price may rise, relative to its opening price. Set by the sale type."],
        ["Curve complete", "The moment the money raised reaches the target. Trading on the curve stops and graduation can run."],
        ["DAMM v2", "Meteora’s pool program. A sale graduates into a DAMM v2 pool, where the wrapper trades from then on."],
        ["Dynamic Bonding Curve", "Meteora’s launch program, which runs each Aegis sale."],
        ["Escrow", "The account that holds the security behind every wrapper. Owned by a program address with no private key."],
        ["Graduation", "The end of a sale: the raise moves into a permanent pool, unsold wrappers are burned and the bridge opens."],
        ["Issuer", "The organisation that issues the security and keeps its legal powers."],
        ["KYC", "Know your customer: the identity checks an issuer runs before approving a holder."],
        ["Migration", "The step of graduation in which Meteora creates the permanent pool from the finished sale."],
        ["Offering documents", "The issuer’s legal description of the asset and its terms, linked from the asset page."],
        ["Partial fill", "How the app sends purchases: if you ask for more than a sale has left, you buy what is left and keep the rest of your money."],
        ["Pool", "The permanent Meteora DAMM v2 market the wrapper trades in after graduation."],
        ["Primary market", "Where the security is issued and redeemed. Only approved holders take part."],
        ["Raise target", "The amount a sale raises. Reaching it ends the sale."],
        ["Register", "Upside’s on-chain list of who may hold the security, with the rules for moving it."],
        ["Sale type", "Fixed par, Book building or Growth capital. It sets the ceiling."],
        ["Secondary market", "Where the wrapper trades: the curve during the sale, then the pool. Anyone takes part."],
        ["Security", "The legal token for the real-world asset. Only approved holders can hold it."],
        ["Transferable but gated", "A model in which a token circulates freely while issuing and redeeming require approval. Aegis follows it."],
        ["Unsold stock", "The security behind wrappers the sale didn’t sell. It stays in the escrow, owed to the issuer."],
        ["Upside", "The compliance programs behind the security: roles, the register and transfer rules."],
        ["Wrapped SOL", "SOL in token form, the way Meteora trades it. On a sale priced in SOL the app wraps and unwraps it for you."],
        ["Wrapper", "The token anyone can trade, backed one for one by the security in escrow. Its symbol starts with c."],
      ]} />
    </>
  ),
};
