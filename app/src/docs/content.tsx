import type { ReactNode } from "react";
import { config, explorerUrl } from "../config";
import { AEGIS_HOOK_PROGRAM_ID, AEGIS_PROGRAM_ID, ACCESS_CONTROL_PROGRAM_ID, METEORA_DBC_PROGRAM_ID, TRANSFER_RESTRICTIONS_PROGRAM_ID } from "../chain/ids";
import { DAMM_V2_PROGRAM_ID } from "../chain/damm";
import { GRADUATION_DEPOSIT_LAMPORTS } from "../chain/graduate";
import { MAX_HOLDERS } from "../chain/issue";
import { METEORA_PROTOCOL_FEE_PCT } from "../chain/meteora";
import { platformConfigAddress, type Platform } from "../chain/platform";
import { formatUnits } from "../lib/amount";
import { ARCHETYPE_CEILING } from "../lib/curve";
import { NETWORK_NAME, REPO_URL } from "../lib/site";
import { poolFeeRange } from "../lib/terms";
import { Callout, Code, DocLink, Ext, H2, Lede, Lifecycle, List, P, Paths, Step, Steps, Table, Terms, TokenModel, UI } from "./ui";

/**
 * The documentation, written to two rules. Structure follows Diátaxis: explanation (why and how
 * it works), a tutorial (learn by doing), how-to guides (get one job done) and reference (look a
 * fact up), kept apart so each page does one job. Style follows Google's developer guide: second
 * person, present tense, active voice, sentence-case headings, conditions before instructions,
 * and on-screen labels in bold exactly as the app shows them.
 *
 * Every claim is taken from the program source; the platform's numbers are read live.
 */

const pct = (v: number) => `${v.toFixed(2).replace(/\.?0+$/, "")}%`;

/** The program's defaults (initialize_platform.rs), used only while the live settings can't be read. */
const DEFAULTS = { creationFeeLamports: 1_000_000_000n, curveFeeBps: 100, issuerCurveFeeSharePct: 0, aegisLpSharePct: 10, minMigrationFeePct: 1, maxMigrationFeePct: 90, minIssuerPermanentPct: 0, minVestingMonths: 3, maxVestingMonths: 24, minPoolFeeBps: 10, maxPoolFeeBps: 300, aegisMigrationFeeSharePct: 0 };

export type Figures = ReturnType<typeof figures>;

export function figures(platform: Platform | undefined) {
  const p = platform?.config ?? DEFAULTS;
  const fee = p.curveFeeBps / 100;
  const meteora = (fee * METEORA_PROTOCOL_FEE_PCT) / 100;
  const issuer = ((fee - meteora) * p.issuerCurveFeeSharePct) / 100;
  const range = poolFeeRange(p);
  return {
    live: Boolean(platform),
    creationFee: `${formatUnits(p.creationFeeLamports, 9, { maxFraction: 3 })} SOL`,
    saleFee: pct(fee),
    meteoraCut: pct(meteora),
    aegisCut: pct(fee - meteora - issuer),
    issuerCut: issuer ? pct(issuer) : null,
    cash: `${p.minMigrationFeePct}–${p.maxMigrationFeePct}%`,
    aegisLp: `${p.aegisLpSharePct}%`,
    issuerLp: `${100 - p.aegisLpSharePct}%`,
    minPermanent: `${p.minIssuerPermanentPct}%`,
    vesting: `${Math.max(1, p.minVestingMonths)} to ${p.maxVestingMonths} months`,
    poolFee: `${pct(range.min / 100)} to ${pct(range.max / 100)}`,
    quotes: platform?.quotes.filter((q) => q.isActive).map((q) => ({ symbol: q.symbol, minRaise: formatUnits(q.minRaise, q.decimals, { maxFraction: 2 }) })) ?? [],
  };
}

const ceilings = Object.values(ARCHETYPE_CEILING);
const gradDeposit = formatUnits(GRADUATION_DEPOSIT_LAMPORTS, 9, { maxFraction: 3 });
const Addr = ({ id }: { id: string }) => (
  <a href={explorerUrl("address", id)} target="_blank" rel="noopener noreferrer" className="font-mono text-[13px] break-all text-blue underline underline-offset-2">{id}</a>
);

export type DocPage = { slug: string; group: string; title: string; summary: string; body: (f: Figures) => ReactNode };

// ================================================================================================
// Start here
// ================================================================================================

const overview: DocPage = {
  slug: "",
  group: "Start here",
  title: "What is Aegis",
  summary: "A launchpad for real-world assets where the security stays compliant and its wrapper trades freely.",
  body: () => (
    <>
      <Lede>
        Aegis is a launchpad on Solana for real-world assets: a building, a bond, a share in a fund. The asset’s legal token
        stays under its issuer’s compliance rules, while a wrapper token, backed one for one, trades freely on an open market.
      </Lede>

      <H2 id="problem">The problem</H2>
      <P>
        A real-world asset on a blockchain is still a security. The law says only approved holders, people who passed the
        issuer’s identity checks (KYC), may own it. So most tokenised assets end up in one of two places: locked in approved
        wallets with no market to trade on, or trading freely with nothing on chain that proves what backs them.
      </P>

      <H2 id="idea">The idea: one asset, two tokens</H2>
      <P>Aegis gives each asset two tokens and keeps them equal.</P>
      <TokenModel />
      <List>
        <li><strong className="text-ink">The security</strong> is the legal claim. Only wallets the issuer approved can hold it, and the issuer keeps the powers securities law requires.</li>
        <li><strong className="text-ink">The wrapper</strong> is a token anyone can buy and sell. Its name is the security’s with a <Code>c</Code> in front, such as <Code>cTWRA</Code> for <Code>TWRA</Code>.</li>
        <li><strong className="text-ink">The escrow</strong> holds the security behind every wrapper. Nobody can create a wrapper without a unit of the security behind it.</li>
      </List>
      <P>
        After the sale, an approved holder can swap between the two at any time, one for one, with no fee. That swap is the{" "}
        <DocLink to="/docs/tokens#bridge">bridge</DocLink>, and it is what keeps the wrapper’s price close to the asset’s value.
      </P>

      <H2 id="built-on">What Aegis is built on</H2>
      <P>Aegis is an orchestrator. It holds no curve maths and runs no market of its own; it sets the rules and connects three systems:</P>
      <Table
        caption="The systems Aegis connects"
        head={["Part", "What it does"]}
        rows={[
          ["Meteora Dynamic Bonding Curve", "Runs the sale. The price rises along a curve as people buy, until the raise target is reached."],
          ["Meteora DAMM v2", "The permanent trading pool the sale graduates into. Its liquidity is locked."],
          ["Upside", "The compliance programs behind the security: who may hold it, the transfer rules, and the issuer’s legal powers."],
          ["The Aegis program", "Sets the limits every launch must meet, holds the escrow, checks the backing, and runs the bridge."],
        ]}
      />

      <H2 id="who">Where to go next</H2>
      <Paths items={[
        { to: "/docs/try-it", kicker: "New here", title: "Try it in ten minutes", text: "Buy into an offering with test tokens, then check its backing yourself." },
        { to: "/docs/launch", kicker: "Issuers", title: "Launch an asset", text: "Turn your security into a sale anyone can join, with one wallet approval." },
        { to: "/docs/guarantees", kicker: "Reviewers", title: "What the program guarantees", text: "Each promise, the code that enforces it, and how to check it." },
      ]} />

      <Callout title="Test network">Aegis runs on {NETWORK_NAME}. Every asset in it is a test launch, and nothing here is an offer of securities or investment advice.</Callout>
    </>
  ),
};

const howItWorks: DocPage = {
  slug: "how-it-works",
  group: "Start here",
  title: "How a launch works",
  summary: "The four stages every launch goes through, who acts at each, and where the money goes.",
  body: (f) => (
    <>
      <Lede>Every launch goes through the same four stages, in the same order. Each one is recorded on chain, and the program refuses to skip one or go back.</Lede>
      <Lifecycle />

      <H2 id="stages">The stages in detail</H2>
      <Table
        caption="What happens at each stage"
        head={["Stage", "What happens", "Who acts"]}
        rows={[
          ["1 · File", <>Aegis creates the security through Upside: a Token-2022 token with Upside’s transfer rules and a supply cap equal to the issue. The issuer receives all four Upside roles; Aegis keeps none. The issuer then sets up the holder register: an Investors group, an Escrow group, the rules between them, and records for the vault and their own wallet.</>, "Issuer"],
          ["2 · Escrow", <>The whole supply is minted straight into the Aegis escrow vault. Before it does, Aegis checks that the compliance setup works, and in particular that the vault is allowed to send the security to investors. Otherwise nobody could ever redeem.</>, "Issuer"],
          ["3 · Offer", <>The issuer fixes the sale terms, and Aegis builds the price curve from them. When the sale opens, Meteora creates the wrapper and mints exactly the supply into its pool. Aegis reads the result back and cancels the whole transaction unless the supply, the decimals and the mint authority are exactly right. Anyone can then buy and sell.</>, "Issuer, then anyone"],
          ["4 · Graduate", <>The purchase that reaches the raise target ends the sale, and Meteora removes the wrapper’s transfer checks for good. Meteora then moves the raise into a permanent pool, and Aegis burns the wrappers the sale didn’t sell and opens the bridge.</>, "Anyone"],
        ]}
      />
      <Callout>
        In the app, the issuer’s part of stages 1 to 3 is eight transactions behind <UI>one</UI> wallet approval. If anything stops half way,
        the <UI>Issuer console</UI> offers <UI>Continue</UI> and finishes the rest.
      </Callout>

      <H2 id="graduation">Graduation needs nobody’s permission</H2>
      <P>
        Graduation is two steps: Meteora’s migration, then Aegis’s <Code>finalize_graduation</Code>. Both are open to anyone. In the app, the
        buyer whose purchase fills the sale does all of it in the same wallet approval as the purchase. If that doesn’t happen, the asset page
        shows <UI>Graduate this sale</UI> to anyone who visits. Whoever does it pays about {gradDeposit} SOL in account deposits for the new pool.
      </P>
      <P>No step of graduation depends on the issuer. Even a paused or misconfigured register can’t hold it back, because no security moves.</P>

      <H2 id="money">Where the money goes</H2>
      <P>At graduation the raise is split in two. The issuer chose the split when they fixed the terms, within limits the platform sets.</P>
      <List>
        <li><strong className="text-ink">Cash to the issuer:</strong> {f.cash} of the raise, which the issuer collects in their console.</li>
        <li><strong className="text-ink">The pool:</strong> the rest becomes liquidity in the permanent pool, paired with wrappers at the final sale price.</li>
      </List>
      <P>
        Nobody can withdraw the pool’s liquidity on day one. Aegis keeps {f.aegisLp} of it, locked forever. The issuer’s {f.issuerLp} is
        locked forever or released monthly over {f.vesting}, as the issuer chose. Each owner keeps earning its share of the pool’s trading fees.
      </P>
      <Callout title="Example">
        An issuer raises 10,000 USDC and takes 50% as cash. At graduation they can collect 5,000 USDC. The other 5,000 USDC, with the matching
        wrappers, opens the pool, so trading continues at the price the sale ended on.
      </Callout>

      <H2 id="unsold">What happens to unsold wrappers</H2>
      <P>
        A sale only sells as many wrappers as it takes to reach the target. The rest are burned at graduation, so the wrapper supply only counts
        wrappers people actually hold. The matching security stays in the vault and is recorded as owed to the issuer, who can claim it once
        their wallet is on the register.
      </P>
      <P>That claim is paid only from what the vault holds above the wrapper supply. Holders are always covered first.</P>

      <H2 id="withdraw">Withdrawing before the sale</H2>
      <P>
        Until the sale opens, nobody holds a wrapper, so the issuer can still cancel the launch and take the security back. Once the sale is
        open, the program refuses: buyers’ wrappers are backed by that security, and it is no longer the issuer’s alone.
      </P>
    </>
  ),
};

const tokens: DocPage = {
  slug: "tokens",
  group: "Start here",
  title: "The security and the wrapper",
  summary: "How the two tokens differ, how the bridge connects them, and why their prices stay together.",
  body: () => (
    <>
      <Lede>Every Aegis asset exists as two tokens. They are equal in value by construction, and they differ in one thing: who may hold them.</Lede>
      <Table
        caption="The two tokens compared"
        head={["", "The security", "The wrapper"]}
        rows={[
          ["What it is", "The legal claim on the asset", "A token backed one for one by the security in escrow"],
          ["Who can hold it", "Only wallets the issuer approved", "Anyone"],
          ["Who created it", "Aegis, through Upside, for the issuer", "Meteora, when the sale opens"],
          ["Who can mint more", "Nobody past the supply cap, unless the issuer raises it in Upside, which is public", "Only the Aegis program, and only against a deposit of the security"],
          ["Transfer checks", "Upside’s rules, on every transfer, permanently", "None. Meteora removes them for good when the sale completes"],
          ["Where it moves", "Between approved wallets and the escrow", "On the sale curve, then on its Meteora pool, and to any wallet"],
        ]}
      />
      <Callout kind="warn" title="Why the wrapper is open to everyone">
        When a sale completes, Meteora permanently removes the wrapper’s transfer checks, for every pool. No launchpad on Meteora can keep a
        wrapper restricted after graduation. Aegis builds on that instead of pretending otherwise: the checks sit where the law needs them, on
        holding the security itself. Many tokenised stocks work the same way: free to trade, with identity checks to mint and redeem.
      </Callout>

      <H2 id="bridge">The bridge</H2>
      <P>After graduation, an approved holder can swap between the two tokens on the asset page:</P>
      <List>
        <li><strong className="text-ink">Redeem:</strong> give wrappers, receive the same number of the security from the escrow. The wrappers are burned.</li>
        <li><strong className="text-ink">Deposit:</strong> give the security, receive the same number of new wrappers. The security goes into the escrow.</li>
      </List>
      <P>Both are one for one, with no fee and no price impact. Redeeming checks that your wallet is on the register; Aegis reads that itself rather than trusting the token’s own checks.</P>

      <H2 id="price">Why the two prices stay together</H2>
      <P>
        The wrapper trades on an open market, so its price can drift. The bridge pulls it back, because anyone approved can profit from a gap,
        and closing the gap is how they profit.
      </P>
      <Callout title="Example">
        Say one TWRA is worth 1.00 USDC and cTWRA trades at 0.95. An approved holder buys 1,000 cTWRA for 950 USDC, redeems them for 1,000 TWRA,
        and keeps the difference. Their buying lifts the price. If cTWRA trades above 1.00, a holder deposits TWRA, receives cTWRA and sells it,
        which brings the price down. Redeeming puts a floor under the price; depositing puts a ceiling on it.
      </Callout>

      <H2 id="at-least">Why the rule is “at least”, not “equal”</H2>
      <P>
        The rule the program enforces is that the escrow holds <em>at least</em> as many units as there are wrappers. The vault can hold more: the
        issuer’s unsold stock waits there, someone may send the security in, or a holder may burn their own wrappers. None of that harms anyone.
        Holding less is the failure case. If it ever happens, the bridge refuses every swap until the vault is whole, and every page shows the
        shortfall.
      </P>
    </>
  ),
};

const tryIt: DocPage = {
  slug: "try-it",
  group: "Start here",
  title: "Try it in ten minutes",
  summary: "A guided first run: buy into an open offering with test tokens, then check its backing yourself.",
  body: () => (
    <>
      <Lede>In this tutorial we buy into an open offering with test tokens, then check for ourselves that what we bought is backed. It takes about ten minutes and costs nothing real.</Lede>

      <H2 id="before">Before you start</H2>
      <List>
        <li>A Solana wallet such as Phantom, Solflare or Backpack, switched to {config.cluster === "devnet" ? "devnet" : "this test network"} in its settings.</li>
        {config.cluster === "devnet" ? (
          <>
            <li>A little devnet SOL for transaction fees, from the <Ext href="https://faucet.solana.com">Solana faucet</Ext>.</li>
            <li>Some devnet USDC to buy with, from <Ext href="https://faucet.circle.com">Circle’s faucet</Ext>. Choose <UI>Solana Devnet</UI>.</li>
          </>
        ) : (
          <li>Test SOL and a test currency on this network. A local test network funds wallets with its own scripts.</li>
        )}
      </List>

      <H2 id="buy">Buy into an offering</H2>
      <Steps>
        <Step title={<>Open the <DocLink to="/registry">Registry</DocLink>.</>} result={<>every asset, with a <UI>Backing</UI> column that reads <UI>1 : 1</UI>.</>}>
          The registry lists every launch, read straight from the chain.
        </Step>
        <Step title={<>Select an asset marked <UI>Offering open</UI>.</>} result={<>the asset page, with its price, how much has been raised, and a box to buy.</>} />
        <Step title={<>Select <UI>Connect wallet</UI> and approve in your wallet.</>} />
        <Step title={<>In the buy box, enter <UI>10</UI> in <UI>You pay</UI>.</>} result={<>how many wrappers you receive, under <UI>You receive about</UI>. The price comes from Meteora’s own maths.</>} />
        <Step title={<>Select the blue <UI>Buy</UI> button and approve in your wallet.</>} result={<><UI>Purchase complete</UI>, with what you paid and received.</>} />
      </Steps>

      <H2 id="check">Check the backing yourself</H2>
      <Steps>
        <Step title={<>On the same page, open the <UI>Proof of backing</UI> tab.</>} result={<>the units held in escrow next to the wrappers in circulation. The escrow holds at least as many.</>} />
        <Step title="Open the escrow vault’s address in the explorer." result="the vault’s balance on a block explorer, outside this website.">
          Every address on the page links to the explorer, so you never have to trust what this site shows.
        </Step>
        <Step title={<>Open <DocLink to="/holdings">My holdings</DocLink>.</>} result={<>your wrappers, with the status <UI>Not approved yet</UI>: the issuer hasn’t approved your wallet to hold the security.</>} />
      </Steps>
      <P>You have bought a wrapper backed by a real security and checked the backing on chain yourself.</P>

      <H2 id="next">Next steps</H2>
      <List>
        <li>To swap wrappers for the security after the sale, see <DocLink to="/docs/redeem">How to redeem or deposit</DocLink>.</li>
        <li>To run a launch of your own, see <DocLink to="/docs/launch">How to launch an asset</DocLink>.</li>
      </List>
    </>
  ),
};

// ================================================================================================
// Guides
// ================================================================================================

const buy: DocPage = {
  slug: "buy",
  group: "Guides",
  title: "How to buy or sell during a sale",
  summary: "Buy wrappers on an open offering, sell them back, and complete a sale.",
  body: (f) => (
    <>
      <Lede>This guide shows you how to buy and sell an asset’s wrapper while its sale is open. You don’t need the issuer’s approval to do either.</Lede>
      <H2 id="buy">Buy</H2>
      <Steps>
        <Step title={<>Open the asset’s page from the <DocLink to="/registry">Registry</DocLink>.</>} />
        <Step title={<>In the buy box, choose <UI>Buy</UI> and enter how much to pay in <UI>You pay</UI>.</>}>
          The box shows what you receive and the price. To protect you, it also shows a <UI>Guaranteed minimum</UI>: if the price moves past
          the limit under <UI>Accept price movement up to</UI> before your purchase lands, it is cancelled instead.
        </Step>
        <Step title={<>Select the <UI>Buy</UI> button and approve in your wallet.</>} />
      </Steps>
      <H2 id="sell">Sell</H2>
      <P>While the sale is open, you can sell wrappers back to the curve at its current price. Choose <UI>Sell</UI> in the same box and follow the same steps.</P>
      <H2 id="fees">What it costs</H2>
      <P>Each trade on the sale pays a {f.saleFee} fee, the same for the first buyer and the last. The price you see already includes it.</P>
      <H2 id="fill">If your purchase completes the sale</H2>
      <P>
        If your purchase reaches the raise target, your wallet asks once for the purchase and the graduation together, and you pay about{" "}
        {gradDeposit} SOL in deposits for the new pool. Your receipt then says <UI>Your purchase completed the sale and opened the bridge.</UI>
      </P>
      <H2 id="after">After the sale</H2>
      <P>The wrapper trades on its permanent Meteora pool. The asset page shows <UI>Buy or sell</UI> with a link to it.</P>
    </>
  ),
};

const redeem: DocPage = {
  slug: "redeem",
  group: "Guides",
  title: "How to redeem or deposit",
  summary: "Get approved by the issuer, then swap wrappers for the security or back, one for one.",
  body: () => (
    <>
      <Lede>This guide shows you how to swap between the wrapper and the security after a sale has graduated. You need the issuer to approve your wallet first.</Lede>
      <H2 id="approved">Get approved</H2>
      <Steps>
        <Step title="Complete the issuer’s identity checks.">Each issuer runs its own KYC. Aegis doesn’t check identities; it only enforces the issuer’s decision.</Step>
        <Step title={<>On <DocLink to="/holdings">My holdings</DocLink>, select <UI>Copy my address</UI> and send it to the issuer.</>} />
        <Step title="Wait for the issuer to approve your wallet." result={<><UI>Approved by the issuer</UI> next to the asset on My holdings.</>}>
          The issuer sees your wallet in their console under <UI>Holders who can’t redeem yet</UI> as soon as you hold the wrapper.
        </Step>
      </Steps>
      <H2 id="redeem">Redeem wrappers for the security</H2>
      <Steps>
        <Step title={<>On the asset page, in the exchange box, choose <UI>Redeem</UI>.</>} />
        <Step title={<>Enter how many wrappers to give in <UI>You give</UI>.</>} result={<>the same number under <UI>You receive</UI>, with <UI>1 : 1 · no fee · no price impact</UI>.</>} />
        <Step title={<>Select <UI>Redeem for</UI> the security and approve in your wallet.</>} />
      </Steps>
      <H2 id="deposit">Deposit the security for wrappers</H2>
      <P>Choose <UI>Deposit</UI> in the same box and follow the same steps. The security goes into the escrow and new wrappers are minted to you.</P>
      <H2 id="blocked">If the exchange is blocked</H2>
      <Table
        caption="Why an exchange can be blocked"
        head={["You see", "What it means"]}
        rows={[
          ["Your wallet isn’t approved to hold … yet", "Ask the issuer to approve your wallet. Until then you can still trade the wrapper."],
          ["The issuer has paused … transfers", "A regulatory hold. Nothing can move the security until the issuer resumes. The wrapper still trades."],
          ["Your … account is frozen by the issuer", "The issuer froze your wallet’s security. Only the issuer can unfreeze it."],
          ["The escrow is unavailable; exchanges are stopped for everyone", "A setting the bridge needs was changed by the issuer, or the escrow is short. Nothing moves until it is fixed."],
        ]}
      />
    </>
  ),
};

const launch: DocPage = {
  slug: "launch",
  group: "Guides",
  title: "How to launch an asset",
  summary: "Create the security, lock it in escrow, fix the terms and open the sale, with one wallet approval.",
  body: (f) => (
    <>
      <Lede>This guide shows you how to take a real-world asset from nothing to an open sale. The app asks your wallet once and does the eight transactions in a row.</Lede>
      <H2 id="before">Before you start</H2>
      <List>
        <li>The legal side is yours: an asset, a right to issue a security against it, and your own process for checking investors.</li>
        <li>A wallet with about {f.creationFee} for the platform fee, plus under 0.1 SOL that Solana holds as deposits for the new accounts.</li>
        <li>Optionally, a public <Code>https://</Code> link to your offering documents. Buyers see it on the asset page.</li>
      </List>
      <H2 id="steps">Launch</H2>
      <Steps>
        <Step title={<>Connect your wallet and select <UI>Launch an asset</UI> in the top bar.</>}>
          If you have launched before, open the <UI>Issuer console</UI> and select <UI>Start a new launch</UI> instead.
        </Step>
        <Step title={<>Under <UI>The asset</UI>, enter the <UI>Name</UI>, <UI>Symbol</UI> and <UI>Total supply</UI>.</>}>
          The wrapper’s symbol is yours with a <Code>c</Code> in front. Under <UI>More options</UI> you can set <UI>Decimals</UI> (6 to 9) and the <UI>Offering documents</UI> link.
        </Step>
        <Step title={<>Under <UI>Sale terms</UI>, keep the <UI>Recommended terms</UI> or select <UI>Customize</UI>.</>}>
          Each term is explained on screen and in <DocLink to="/docs/sale-terms">Sale terms</DocLink>. The preview shows the price at graduation, your cash and the pool as you change them.
        </Step>
        <Step title={<>Check the <UI>Review</UI> and select <UI>Launch · approve once</UI>.</>} result="each of the eight steps ticking off, then a link to your new asset page." />
      </Steps>
      <Callout>If the launch stops half way, nothing is lost. Open the <UI>Issuer console</UI> and select <UI>Continue</UI> on the unfinished launch. Until the sale opens you can also select <UI>Cancel launch</UI> to take the security back.</Callout>
      <H2 id="what-happens">What the eight steps do</H2>
      <Table
        caption="The eight launch transactions"
        head={["Step", "What it does"]}
        rows={[
          ["Create the security", `Creates your Token-2022 security through Upside and pays the ${f.creationFee} platform fee. You receive all four Upside roles.`],
          ["Set up the holder register", `Starts Upside’s register for the security, for up to ${MAX_HOLDERS.toLocaleString("en-US")} holders.`],
          ["Add the Investors and Escrow groups", "Creates the two groups and the two rules between them: investor to vault (deposit) and vault to investor (redeem)."],
          ["Register the escrow vault", "Puts the Aegis vault on the register, in the Escrow group."],
          ["Register your wallet", "Puts your wallet in the Investors group, so you can later claim your unsold stock."],
          ["Lock the supply in escrow", "Mints the whole supply into the vault, after Aegis checks the setup works."],
          ["Fix the sale terms with Meteora", "Creates the sale’s configuration. Aegis builds the curve from your terms."],
          ["Open the sale", "Meteora creates the wrapper and opens trading. Aegis checks the result."],
        ]}
      />
    </>
  ),
};

const manage: DocPage = {
  slug: "manage",
  group: "Guides",
  title: "How to run your launch",
  summary: "Approve investors, collect your raise and unsold stock, and use your legal powers.",
  body: () => (
    <>
      <Lede>This guide shows you how to manage a launch from the Issuer console: approving investors, collecting money and using the powers a security issuer keeps.</Lede>
      <Callout>Open the <UI>Issuer console</UI> from the top bar and select <UI>Manage</UI> on a launch. It has three tabs: <UI>Money</UI>, <UI>Investors</UI> and <UI>Legal powers</UI>.</Callout>

      <H2 id="approve">Approve investors</H2>
      <P>Approve a wallet only after your own identity checks. Aegis finds wallets for you; it doesn’t check anyone’s identity.</P>
      <Steps>
        <Step title={<>Open the <UI>Investors</UI> tab.</>} />
        <Step title="Choose the wallets.">
          Tick wallets under <UI>Holders who can’t redeem yet</UI>: people who hold the wrapper but aren’t approved. Or paste addresses under <UI>Wallets to approve</UI> and select <UI>Add</UI> for each.
        </Step>
        <Step title={<>Select <UI>Approve selected</UI> or <UI>Approve all</UI> and approve once in your wallet.</>} result={<>the wallets in <UI>The register</UI> with the status <UI>Active</UI>.</>} />
      </Steps>
      <P>To take a wallet off the register, select <UI>Remove…</UI> next to it. It can no longer receive the security; what it already holds stays with it.</P>

      <H2 id="collect">Collect your money</H2>
      <P>After graduation, the <UI>Money</UI> tab lists what you can collect and from where.</P>
      <Table
        caption="What an issuer can collect"
        head={["Source", "Where to collect it"]}
        rows={[
          ["Your raise", <>Select <UI>Collect</UI> on the Money tab. This is your cash share of the raise.</>],
          ["Unsold stock", <>Select <UI>Collect</UI>. Your wallet must be on the register; the console tells you if it isn’t.</>],
          ["Trading fees from the pool", <>On Meteora’s site, where your pool position lives.</>],
          ["Pool liquidity that unlocks", <>On Meteora’s site, as each monthly period unlocks.</>],
        ]}
      />

      <H2 id="powers">Use your legal powers</H2>
      <P>Securities law requires an issuer to keep some control. The <UI>Legal powers</UI> tab has two, and each asks you to type the symbol before it runs. Every use is public.</P>
      <List>
        <li><UI>Pause transfers…</UI> stops every movement of the security, including redemptions and deposits. The wrapper still trades. Use it for a regulatory hold.</li>
        <li><UI>Freeze…</UI> stops one wallet’s security from moving. Nobody else is affected.</li>
      </List>
      <Callout kind="warn">Upside also gives you force transfer and burn, for court orders. Aegis deliberately gives them no button. If they are ever used on the escrow, the backing check on every page shows it within seconds.</Callout>
    </>
  ),
};

// ================================================================================================
// Trust
// ================================================================================================

const guarantees: DocPage = {
  slug: "guarantees",
  group: "Trust",
  title: "What the program guarantees",
  summary: "Each promise Aegis makes, the code that enforces it, and how to check it yourself.",
  body: (f) => (
    <>
      <Lede>These rules hold for every launch, whoever the issuer is. Each one is enforced by the Aegis program on chain, not by this website, and you can check each one yourself.</Lede>
      <Table
        caption="Guarantees and how they are enforced"
        head={["Guarantee", "How the program enforces it", "Check it yourself"]}
        rows={[
          ["Every wrapper is backed", <>Every instruction that moves either token ends by re-reading the vault and the wrapper supply, and fails if the vault holds less (<Code>assert_backing</Code>).</>, "Proof of backing tab: vault balance against wrapper supply, both linked to the explorer."],
          ["Nobody can print wrappers", "When the sale opens, Aegis checks that mint rights went to its own program address, not the issuer, and that nobody can freeze the wrapper. Otherwise the whole launch is cancelled.", "The wrapper’s mint in the explorer: its mint authority is the launch’s Aegis address."],
          ["The supply matches the escrow", "The vault is filled by Aegis itself, in one instruction, before the sale. When Meteora creates the wrapper, Aegis checks its supply equals the escrow exactly.", "The Supply figure on the asset page against the security’s mint."],
          ["The price can’t run away", <>Aegis builds the curve itself as one smooth segment, so it can’t hide a spike or a thin patch. The price can’t rise past the ceiling: {ceilings.map((c) => c.multiple.replace(/0×$/, "×")).join(", ")}.</>, "The chart’s dashed ceiling line, and the Price ceiling row in Terms."],
          ["No day-one exit", `No part of the pool can be withdrawn at graduation. Aegis’s ${f.aegisLp} is locked forever; the issuer’s share is locked forever or unlocks over ${f.vesting}.`, "Where the money goes tab."],
          ["Fees can’t change mid-sale", "The fee is flat, collected only in the currency buyers pay with, and fixed in the sale’s Meteora configuration when the terms are set.", "Fee per sale trade in Terms."],
          ["Holders can always leave", "The redemption path is checked before the vault is funded, before the sale opens, and on every swap. A raised supply cap can stop a sale from opening, but never stops redemption.", "Try a redemption, or read the bridge code."],
          ["Graduation can’t be blocked", "Migration and settlement are open to anyone, and settlement moves no security, so no issuer setting can stop it.", "Graduate this sale appears for any visitor once a sale fills."],
        ]}
      />
      <H2 id="read-the-check">Read the check</H2>
      <P>This is the function every token-moving instruction ends with. If it fails, the whole transaction is undone.</P>
      <pre className="mt-4 max-w-[68ch] overflow-x-auto bg-ink p-5 font-mono text-[13px] leading-[1.8] text-[#E4DECF]">{`pub fn assert_backing(&self) -> Result<()> {
    require_gte!(
        self.real_rwa_locked,   // the security in the vault
        self.crwa_minted,       // wrappers in existence
        AegisError::BackingShortfall
    );
    Ok(())
}`}</pre>
      <P><Ext href={`${REPO_URL}/blob/main/programs/aegis/src/state/launch.rs`}>See it in the source</Ext>, or read the full design in <Ext href={`${REPO_URL}/blob/main/design.md`}>design.md</Ext>.</P>
    </>
  ),
};

const limits: DocPage = {
  slug: "limits",
  group: "Trust",
  title: "What Aegis can’t guarantee",
  summary: "The honest limits: what depends on the issuer, on the law, and on the systems Aegis builds on.",
  body: () => (
    <>
      <Lede>A blockchain can prove what happens on chain. It can’t see a building. This page lists what Aegis does not guarantee, and what protects you in each case.</Lede>

      <H2 id="real-asset">The real-world asset itself</H2>
      <P>
        The chain proves that every wrapper is matched by a unit of the security. It can’t prove that the security is matched by a real building,
        bond or share. That link is the issuer’s legal promise, set out in their offering documents, which the asset page links to under{" "}
        <UI>Offering documents</UI>. Read them, and judge the issuer as you would off chain.
      </P>

      <H2 id="issuer-powers">The issuer’s legal powers</H2>
      <P>
        Securities law requires an issuer to approve holders, freeze a wallet, pause transfers, and move or burn tokens under a court order. Through
        Upside, the issuer keeps all of these, and they reach every account, including the Aegis escrow. Aegis can’t remove them. What it does
        instead:
      </P>
      <List>
        <li>It gives force transfer and burn no button in the app.</li>
        <li>It checks the vault on every swap. If the vault ever holds less than the wrappers in circulation, the bridge stops for everyone and every page shows <UI>short</UI> in red.</li>
        <li>A loss comes out of the issuer’s own unsold stock first. The issuer’s claim pays only from what the vault holds above the wrapper supply.</li>
        <li>Every use of a power is a public transaction.</li>
      </List>

      <H2 id="issuer-settings">Settings the issuer controls</H2>
      <P>
        The issuer owns the register and can change it: close the redemption rule, pause transfers, point the security at different transfer checks,
        or raise its supply cap. Aegis checks these each time they matter and refuses to act on a broken setup. It won’t lock the asset, open a sale,
        or run a swap into a launch nobody could leave. It can’t make the issuer reopen a path they closed.
      </P>

      <H2 id="free-wrapper">The wrapper is open to anyone</H2>
      <P>
        Meteora removes the wrapper’s transfer checks when a sale completes, so anyone can hold the wrapper, anywhere. Identity checks apply when the
        wrapper becomes the security, at redemption. Whether the wrapper may be offered in a given country is a legal question for each issuer.
      </P>

      <H2 id="platform">The platform admin</H2>
      <P>
        The Aegis admin can change fees and limits, approve or retire currencies, and pause new launches. None of it reaches a sale already open:
        its terms are fixed in its Meteora configuration. The admin holds no power over any security, escrow or wrapper.
      </P>

      <H2 id="dependencies">The systems underneath</H2>
      <P>Aegis relies on Solana, Meteora and Upside working as published. A fault in any of them is outside what the Aegis program can prevent.</P>
      <Callout kind="warn" title="Not audited">The Aegis program has an extensive test suite, including attack tests against the real Meteora program, but it has not had an external audit. Treat it as test software.</Callout>
    </>
  ),
};

// ================================================================================================
// Reference
// ================================================================================================

const saleTerms: DocPage = {
  slug: "sale-terms",
  group: "Reference",
  title: "Sale terms",
  summary: "Every term an issuer sets, what it controls, and the range the platform allows.",
  body: (f) => (
    <>
      <Lede>An issuer sets these terms once, before the sale opens. After that, nobody can change them.</Lede>
      {!f.live && <Callout kind="warn">The live platform settings couldn’t be read, so the ranges below are the program’s defaults.</Callout>}
      <Table
        caption="Sale terms"
        head={["Term", "What it controls", "Allowed"]}
        rows={[
          ["Currency", "What buyers pay with, and what the raise is counted in.", f.quotes.length ? f.quotes.map((q) => q.symbol).join(", ") : "Currencies the admin approved"],
          ["Opening price", "The price of one wrapper when the sale opens.", "Above zero"],
          ["Sale type", "How far the price may rise during the sale. The curve can never pass the ceiling.", ceilings.map((c) => `${c.label} ${c.multiple.replace(/0×$/, "×")}`).join(" · ")],
          ["Raise target", "How much the sale raises. Reaching it ends the sale and starts graduation.", f.quotes.length ? f.quotes.map((q) => `at least ${q.minRaise} ${q.symbol}`).join(" · ") : "At least the currency’s minimum"],
          ["Cash share", "How much of the raise the issuer takes as cash. The rest becomes the pool.", f.cash],
          ["Pool lock", `How the issuer’s ${f.issuerLp} of the pool is locked: forever, released monthly, or a mix.`, `At least ${f.minPermanent} forever; releases over ${f.vesting}`],
          ["Pool fee", "The trading fee in the permanent pool after graduation.", f.poolFee],
        ]}
      />
      <H2 id="fixed">Set by Aegis, not the issuer</H2>
      <P>These are the same for every launch, because leaving any of them open would let an issuer harm buyers:</P>
      <List>
        <li>The curve’s shape: one smooth segment, built from the terms above.</li>
        <li>The wrapper’s supply, equal to the escrow, and its mint rights, held by the Aegis program.</li>
        <li>The sale fee: flat, and collected only in the currency buyers pay with.</li>
        <li>No pool liquidity that can be withdrawn on day one.</li>
      </List>
      <H2 id="limits">Asset limits</H2>
      <Table
        caption="Asset limits"
        head={["Field", "Limit"]}
        rows={[
          ["Name", "Up to 32 characters"],
          ["Symbol", "Up to 9 characters in the app, so the wrapper’s c fits"],
          ["Decimals", "6 to 9, the range Meteora accepts. The wrapper gets the same."],
          ["Offering documents", <>A <Code>https://</Code> link of up to 200 characters</>],
        ]}
      />
    </>
  ),
};

const fees: DocPage = {
  slug: "fees",
  group: "Reference",
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
          ["Sale trade fee", `${f.saleFee} of each trade`, "Buyers and sellers on the curve", `${f.meteoraCut} Meteora, ${f.aegisCut} Aegis${f.issuerCut ? `, ${f.issuerCut} the issuer` : ""}`],
          ["Pool trade fee", f.poolFee, "Traders in the permanent pool", "Aegis and the issuer, by their pool shares, under Meteora’s pool rules"],
          ["Migration fee", "0.2% of the liquidity", "Taken at graduation", "Meteora"],
          ["Bridge", "0", "Nobody", "—"],
          ["Account deposits", "Under 0.1 SOL to launch, about " + gradDeposit + " SOL to graduate", "Whoever creates the accounts", "Held by Solana as rent"],
        ]}
      />
      <P>The issuer’s cash share of the raise is not a fee. It is the money the sale raises for them, {f.cash} of the target.</P>
    </>
  ),
};

const stages: DocPage = {
  slug: "stages",
  group: "Reference",
  title: "Launch stages",
  summary: "Each stage a launch can be in, as the app shows it and as the program records it.",
  body: () => (
    <>
      <Lede>A launch’s stage only ever moves forward. Each stage allows a fixed set of actions.</Lede>
      <Table
        caption="Launch stages"
        head={["In the app", "On chain", "What it means", "What is possible"]}
        rows={[
          ["Preparing · step 1", <Code>TokenCreated</Code>, "The security exists. The register is being set up.", "The issuer continues the launch"],
          ["Preparing · step 2", <Code>Funded</Code>, "The whole supply is in the escrow.", "Fix the terms, or cancel"],
          ["Preparing · step 3", <Code>Configured</Code>, "The sale terms are fixed with Meteora.", "Open the sale, or cancel"],
          ["Offering open", <Code>Live</Code>, "The wrapper exists and the sale is trading.", "Anyone buys or sells"],
          ["Graduated · bridge open", <Code>Graduated</Code>, "The pool is open and unsold wrappers are burned.", "Trade on Meteora, redeem and deposit"],
          ["Withdrawn", <Code>Aborted</Code>, "Cancelled before the sale; the asset went back.", "Nothing"],
        ]}
      />
      <P>Between a sale filling and graduation, the asset page shows <UI>Sale filled · one step left</UI> until someone graduates it.</P>
    </>
  ),
};

const addresses: DocPage = {
  slug: "addresses",
  group: "Reference",
  title: "Programs and addresses",
  summary: "Every program Aegis uses, with links to check each one in the explorer.",
  body: () => (
    <>
      <Lede>The programs a launch touches, on {NETWORK_NAME}. Each address opens in the explorer.</Lede>
      <Table
        caption="Program addresses"
        head={["Program", "Address", "Role"]}
        rows={[
          ["Aegis", <Addr id={AEGIS_PROGRAM_ID.toBase58()} />, "Rules, escrow, backing checks and the bridge"],
          ["Aegis hook", <Addr id={AEGIS_HOOK_PROGRAM_ID.toBase58()} />, "Approves every wrapper transfer during the sale. Meteora requires a hook to give mint rights to Aegis."],
          ["Meteora Dynamic Bonding Curve", <Addr id={METEORA_DBC_PROGRAM_ID.toBase58()} />, "The sale"],
          ["Meteora DAMM v2", <Addr id={DAMM_V2_PROGRAM_ID.toBase58()} />, "The permanent pool"],
          ["Upside Transfer Restrictions", <Addr id={TRANSFER_RESTRICTIONS_PROGRAM_ID.toBase58()} />, "The security’s register and transfer rules"],
          ["Upside Access Control", <Addr id={ACCESS_CONTROL_PROGRAM_ID.toBase58()} />, "The issuer’s roles, freeze and supply cap"],
        ]}
      />
      <H2 id="accounts">Accounts worth knowing</H2>
      <Table
        caption="Accounts"
        head={["Account", "Where", "What it holds"]}
        rows={[
          ["Platform settings", <Addr id={platformConfigAddress().toBase58()} />, "Fees and limits for new launches"],
          ["Launch record", <>Seeds <Code>launch</Code> + the security’s mint</>, "The stage, both mints, the escrow and the backing ledger. One per security."],
          ["Aegis authority", <>Seeds <Code>authority</Code> + the launch</>, "Owns the escrow and holds the wrapper’s mint rights. Holds no data and no keys."],
          ["Escrow vault", "The security’s token account owned by the Aegis authority", "The security behind every wrapper"],
        ]}
      />
      <P>The full design, with every instruction and invariant, is in <Ext href={`${REPO_URL}/blob/main/design.md`}>design.md</Ext>. The code is on <Ext href={REPO_URL}>GitHub</Ext>.</P>
    </>
  ),
};

const messages: DocPage = {
  slug: "messages",
  group: "Reference",
  title: "Messages you might see",
  summary: "What the app’s warnings and the program’s refusals mean, and what to do.",
  body: () => (
    <>
      <Lede>When the program refuses something, the app explains it in plain words. These are the ones you are most likely to meet.</Lede>
      <Table
        caption="Common messages"
        head={["Message", "What it means", "What to do"]}
        rows={[
          ["Your wallet isn’t approved yet", <>The program read the register and your wallet isn’t in the Investors group (<Code>HolderNotApproved</Code>).</>, "Send your address to the issuer and ask for approval. You can still trade the wrapper."],
          ["The issuer has paused transfers", <>A regulatory hold on the security (<Code>TransfersPaused</Code>).</>, "Wait for the issuer to resume. The wrapper still trades."],
          ["The escrow is short", <>The vault holds less than the wrappers in circulation (<Code>BackingShortfall</Code>).</>, "The bridge stops for everyone until the vault is whole. Contact the issuer."],
          ["The escrow is unavailable; exchanges are stopped for everyone", "The issuer changed a setting the bridge needs: the vault was frozen, or the redemption rule was closed.", "Only the issuer can fix it. Your wrapper still trades."],
          ["The price moved before your trade landed", "The price passed your limit, so the trade was cancelled. Nothing was spent.", "Check the new price and try again."],
          ["This wallet can’t change the register", "The connected wallet doesn’t hold the issuer’s role for this security.", "Switch to the issuer’s wallet."],
          ["Your supply is too small for these terms", "At this opening price, the raise needs more tokens than you are issuing.", "Raise the price, lower the raise, or issue more."],
        ]}
      />
    </>
  ),
};

const glossary: DocPage = {
  slug: "glossary",
  group: "Reference",
  title: "Glossary",
  summary: "The words used across Aegis, in plain language.",
  body: () => (
    <>
      <Lede>The words used across Aegis and these docs, in plain language.</Lede>
      <Terms items={[
        ["Approved holder", "A wallet the issuer put on the security’s register, in the Investors group, after its own identity checks."],
        ["Bonding curve", "A price that rises as people buy and falls as they sell, set by a formula instead of an order book. Meteora runs it."],
        ["Bridge", "Swapping the wrapper for the security, or back, one for one, after graduation."],
        ["Cash share", "The part of the raise the issuer takes as cash at graduation. The rest becomes the pool."],
        ["Escrow vault", "The account that holds the security behind every wrapper. Owned by the Aegis program, not by a person."],
        ["Graduation", "The end of a sale: the raise moves into a permanent pool, unsold wrappers are burned and the bridge opens."],
        ["Issuer", "The organisation that issues the security and keeps its legal powers."],
        ["KYC", "Know your customer: the identity checks an issuer runs before approving a holder."],
        ["Offering documents", "The issuer’s legal description of the asset and its terms, linked from the asset page."],
        ["Pool", "The permanent Meteora DAMM v2 market the wrapper trades in after graduation."],
        ["Raise target", "The amount a sale raises. Reaching it ends the sale."],
        ["Register", "Upside’s on-chain list of who may hold the security, and the rules for moving it."],
        ["Sale type", "Fixed par, Book building or Growth capital. It sets how far the price may rise during the sale."],
        ["Security", "The legal token for the real-world asset. Only approved holders can hold it."],
        ["Unsold stock", "The security behind wrappers the sale didn’t sell. It stays in the vault, owed to the issuer."],
        ["Wrapper", "The token anyone can trade, backed one for one by the security in escrow. Its symbol starts with c."],
      ]} />
    </>
  ),
};

export const DOC_PAGES: DocPage[] = [overview, howItWorks, tokens, tryIt, buy, redeem, launch, manage, guarantees, limits, saleTerms, fees, stages, addresses, messages, glossary];
export const DOC_GROUPS = ["Start here", "Guides", "Trust", "Reference"] as const;
