import { MAX_HOLDERS } from "../../chain/issue";
import { ceilingLabel, ceilings, gradDeposit, type DocPage } from "../shared";
import { Callout, Code, DocLink, H2, Lede, List, P, Step, Steps, Table, UI } from "../ui";

// ================================================================================================
// For investors
// ================================================================================================

export const buy: DocPage = {
  slug: "buy",
  group: "For investors",
  title: "How to buy or sell during a sale",
  summary: "Buy wrappers on an open offering, sell them back, and complete a sale.",
  body: (f) => (
    <>
      <Lede>This guide shows you how to buy and sell an asset’s wrapper while its sale is open. You don’t need the issuer’s approval for either.</Lede>
      <H2 id="before">Before you buy</H2>
      <List>
        <li>Read the asset page: the <UI>Terms</UI> tab shows the price range and the raise target, and <UI>Offering documents</UI> links to the issuer’s description of the asset.</li>
        <li>Check the <UI>Backing</UI> figure reads <UI>1 : 1</UI>.</li>
        <li>Have some of the sale’s currency and a little SOL for fees in your wallet. On devnet, the <DocLink to="/faucet">Faucet</DocLink> gives you both.</li>
      </List>
      <H2 id="buy">Buy</H2>
      <Steps>
        <Step title={<>Open the asset’s page from the <DocLink to="/registry">Registry</DocLink>.</>} />
        <Step title={<>In the buy box, choose <UI>Buy</UI> and enter how much to pay in <UI>You pay</UI>.</>}>
          The box shows what you receive at the current price. It also shows a <UI>Guaranteed minimum</UI>: if the price moves past the limit
          under <UI>Accept price movement up to</UI> before your purchase lands, the purchase is cancelled and nothing is spent.
        </Step>
        <Step title={<>Select the <UI>Buy</UI> button and approve in your wallet.</>} result={<><UI>Purchase complete</UI>, with what you paid and received.</>} />
      </Steps>
      <P>
        <UI>Max</UI> fills in the most you can pay, or what is left in the sale if that is less. The quick amounts above it are sized to the
        sale’s currency: 100, 500 and 1,000 for USDC; 0.1, 0.5 and 1 for SOL.
      </P>
      <H2 id="sol">Paying in SOL</H2>
      <P>
        A sale can be priced in SOL. Meteora trades SOL in its token form, wrapped SOL, but you don’t have to wrap anything yourself. The box
        counts your SOL and any wrapped SOL you hold as one balance, and the purchase handles the rest in the same transaction:
      </P>
      <List>
        <li>Wrapped SOL you already hold is spent first. Only the shortfall is wrapped from your SOL.</li>
        <li>Anything the app wrapped and didn’t spend comes straight back to you as SOL. Wrapped SOL you held before is left as it was.</li>
        <li><UI>Max</UI> keeps back what the transaction itself needs: the network fee, the small deposit Solana holds for any new account the purchase opens, and the minimum a wallet must keep. The rest is yours to spend.</li>
      </List>
      <P>When you sell on a sale priced in SOL, you receive plain SOL.</P>
      <H2 id="sell">Sell</H2>
      <P>To sell wrappers back to the curve while the sale is open, choose <UI>Sell</UI> in the same box and follow the same steps. You receive the curve’s current price, minus the fee.</P>
      <H2 id="cost">What it costs</H2>
      <P>Each trade pays a {f.saleFee} fee, the same at any point in the sale. The amounts the box shows already include it.</P>
      <H2 id="fill">If your purchase completes the sale</H2>
      <P>
        If your purchase reaches the raise target, you buy only what is left and keep the rest of your money. Your wallet asks once for the
        purchase and the graduation together, and you pay about {gradDeposit} SOL in deposits for the new pool. Your receipt says{" "}
        <UI>Your purchase completed the sale and opened the bridge.</UI>
      </P>
      <P>
        Graduation only rides along if you will still have that SOL after the purchase. If you won’t, the box says so before you buy: your
        purchase still completes the sale, and anyone can graduate it from the asset page afterwards.
      </P>
      <H2 id="after">After the sale</H2>
      <P>The wrapper trades on its permanent Meteora pool. The asset page shows <UI>Buy or sell</UI> with a link to it.</P>
    </>
  ),
};

export const redeem: DocPage = {
  slug: "redeem",
  group: "For investors",
  title: "How to get approved, redeem and deposit",
  summary: "Get on the issuer’s register, then swap wrappers for the security or back, one for one.",
  body: () => (
    <>
      <Lede>This guide shows you how to swap between the wrapper and the security once a sale has graduated. The issuer has to approve your wallet first.</Lede>
      <H2 id="approved">Get approved</H2>
      <Steps>
        <Step title="Complete the issuer’s identity checks.">Each issuer runs its own checks. Aegis doesn’t check identities; it only enforces the issuer’s decision.</Step>
        <Step title={<>On <DocLink to="/holdings">My holdings</DocLink>, select <UI>Copy my address</UI> and send it to the issuer.</>} />
        <Step title="Wait for the issuer to approve your wallet." result={<><UI>Approved by the issuer</UI> next to the asset on My holdings.</>}>
          Issuers see your wallet in their console under <UI>Holders who can’t redeem yet</UI> as soon as you hold the wrapper.
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
        head={["The box says", "What it means"]}
        rows={[
          ["Your wallet isn’t approved to hold … yet", "Ask the issuer to approve your wallet. Until then you can still trade the wrapper."],
          ["The issuer has paused … transfers", "A regulatory hold. The security can’t move until the issuer resumes; the wrapper still trades."],
          ["Your … account is frozen by the issuer", "The issuer froze your wallet’s security. Only the issuer can unfreeze it."],
          ["The escrow is unavailable; exchanges are stopped for everyone", "The issuer changed a setting the bridge needs, or the escrow is short. Nothing moves until it is fixed."],
        ]}
      />
    </>
  ),
};

// ================================================================================================
// For issuers
// ================================================================================================

export const launch: DocPage = {
  slug: "launch",
  group: "For issuers",
  title: "How to launch an asset",
  summary: "From your security to an open sale: three screens, one wallet approval, eight transactions.",
  body: (f) => (
    <>
      <Lede>This guide shows you how to take a real-world asset from nothing to an open sale. The app asks your wallet once and sends the eight transactions in a row.</Lede>
      <H2 id="before">Before you start</H2>
      <List>
        <li>The legal side is yours: the asset, the right to issue a security against it, offering documents and your process for checking investors.</li>
        <li>A wallet with {f.creationFee} for the launch fee, plus under 0.1 SOL that Solana holds as deposits for the new accounts.</li>
        <li>A public <Code>https://</Code> link to your offering documents. It is optional, but buyers look for it.</li>
        <li>Your terms, or a starting point: read <DocLink to="/docs/sale-terms">How to choose your sale terms</DocLink>.</li>
      </List>
      <H2 id="steps">Launch</H2>
      <Steps>
        <Step title={<>Connect your wallet and select <UI>Launch an asset</UI> in the top bar.</>}>If you have launched before, open the <UI>Issuer console</UI> and select <UI>Start a new launch</UI>.</Step>
        <Step title={<>Under <UI>The asset</UI>, enter the <UI>Name</UI>, <UI>Symbol</UI> and <UI>Total supply</UI>.</>}>
          The wrapper’s symbol is yours with a <Code>c</Code> in front. Under <UI>More options</UI> you can set <UI>Decimals</UI> (6 to 9) and the <UI>Offering documents</UI> link.
        </Step>
        <Step title={<>Under <UI>Sale terms</UI>, choose what <UI>Buyers pay in</UI>, then keep the <UI>Recommended terms</UI> or select <UI>Customize</UI>.</>}>
          Every currency the platform approves is listed. Switching currency starts the price and the raise afresh in that currency’s terms.
          The preview shows the price at graduation, your cash, the pool and the unsold supply as you change the terms.
        </Step>
        <Step title={<>Check the <UI>Review</UI> and select <UI>Launch · approve once</UI>.</>} result="each of the eight steps ticking off, then links to your asset page and console." />
      </Steps>
      <Callout>If the launch stops half way, nothing is lost. Open the <UI>Issuer console</UI> and select <UI>Continue</UI>. Until the sale opens you can also select <UI>Cancel launch</UI> to take the security back.</Callout>
      <H2 id="what-happens">What the eight transactions do</H2>
      <Table
        caption="The eight launch transactions"
        head={["Step", "What it does"]}
        rows={[
          ["Create the security", `Creates your Token-2022 security through Upside, with a supply cap equal to your issue, and pays the ${f.creationFee} launch fee. You receive all four Upside roles.`],
          ["Set up the holder register", `Starts Upside’s register for the security, for up to ${MAX_HOLDERS.toLocaleString("en-US")} holders.`],
          ["Add the Investors and Escrow groups", "Creates the two groups and the two rules between them: deposit and redeem."],
          ["Register the escrow vault", "Puts the Aegis escrow on the register, in the Escrow group."],
          ["Register your wallet", "Puts your wallet in the Investors group, so you can claim unsold stock later."],
          ["Lock the supply in escrow", "Mints your whole supply into the escrow, after Aegis checks the setup works."],
          ["Fix the sale terms with Meteora", "Creates the sale’s Meteora configuration. Aegis builds the curve from your terms."],
          ["Open the sale", "Meteora creates the wrapper and opens the curve. Aegis checks the result before anyone can buy."],
        ]}
      />
    </>
  ),
};

export const saleTermsGuide: DocPage = {
  slug: "sale-terms",
  group: "For issuers",
  title: "How to choose your sale terms",
  summary: "Every term you set, its allowed range, and how each choice changes your sale and your market.",
  body: (f) => (
    <>
      <Lede>This guide explains each sale term, what it changes and how to choose it. You set the terms once, before the sale opens; after that nobody can change them.</Lede>
      {!f.live && <Callout kind="warn">The live platform settings couldn’t be read, so the ranges below are the program’s defaults.</Callout>}
      <Table
        caption="Sale terms"
        head={["Term", "What it controls", "Allowed", "Recommended"]}
        rows={[
          ["Currency", "What buyers pay with, and what you raise.", f.quotes.length ? f.quotes.map((q) => q.symbol).join(", ") : "Currencies the admin approved", "USDC"],
          ["Opening price", "What the first buyer pays for one unit.", "Above zero", "1.00 USDC, or 0.01 SOL"],
          ["Sale type and rise", "How far the price may rise over the sale.", ceilings.map((c) => `${c.label} up to ${ceilingLabel(c.multiple)}`).join(" · "), "Book building, 1.21×"],
          ["Raise target", "How much the sale raises. Reaching it ends the sale.", f.quotes.length ? f.quotes.map((q) => `at least ${q.minRaise} ${q.symbol}`).join(" · ") : "At least the currency’s minimum", "10,000 USDC, or 10 SOL"],
          ["Cash share", "How much of the raise you take as cash. The rest becomes the pool.", f.cash, "50%"],
          ["Pool lock", `How your ${f.issuerLp} of the pool is locked.`, `Forever, released over ${f.vesting}, or a mix`, "30% forever, the rest over 12 months"],
          ["Pool fee", "The trading fee in the pool after graduation.", f.poolFee, "1%"],
        ]}
      />

      <H2 id="currency">Choosing a currency</H2>
      <P>
        The currency is what buyers pay with, what your raise is counted in and what the pool trades against after graduation. It is fixed
        with the rest of the terms.
      </P>
      <List>
        <li><strong className="text-ink">USDC</strong> suits most real-world assets. Their value is usually stated in dollars, so the price buyers see and the money you raise keep a steady value.</li>
        <li><strong className="text-ink">SOL</strong> reaches buyers who hold SOL and nothing else. Your raise, and the pool’s price, then move with SOL’s own price.</li>
      </List>
      <P>Each currency has its own minimum raise, shown in the table above.</P>

      <H2 id="type">Choosing a sale type</H2>
      <P>Pick the narrowest band that suits the asset. A narrow band tells buyers the price will stay close to where you opened it; a wide band lets demand decide more.</P>
      <List>
        <li><strong className="text-ink">Fixed par</strong> suits notes, bills and other instruments with a set value.</li>
        <li><strong className="text-ink">Book building</strong> suits most assets: a real but bounded discovery range.</li>
        <li><strong className="text-ink">Growth capital</strong> suits assets whose value depends most on demand.</li>
      </List>

      <H2 id="raise">Raise target, price and supply</H2>
      <P>
        The raise target, opening price and rise together decide how many wrappers the sale sells. Your supply must cover those, plus the wrappers
        paired with the raise in the pool, plus a safety margin Meteora requires. If it doesn’t, the form shows <UI>Your supply is too small for these terms</UI>;
        raise the price, lower the target, or issue more. Anything the sale doesn’t need is burned at graduation and owed back to you as the security.
      </P>

      <H2 id="cash">Cash or depth</H2>
      <P>
        The cash share is the money you take; the rest becomes the pool your holders trade in. More cash means a thinner pool, where each trade
        moves the price more. Less cash means a deeper market and a more stable price.
      </P>

      <H2 id="lock">Locking your share of the pool</H2>
      <P>
        Liquidity locked forever can never be withdrawn but keeps earning fees. Liquidity that vests is released in 30-day periods, starting one
        period after graduation. Nothing can be withdrawn on day one, whatever you choose.
      </P>

      <H2 id="fee">Pool fee</H2>
      <P>Keep it low. The bridge keeps the wrapper’s price near the asset’s value only when the gap is worth closing, and a high fee widens the gap traders must cross first.</P>

      <H2 id="fixed">What you can’t choose</H2>
      <P>Aegis sets these for every launch, because leaving any of them open would let an issuer harm buyers:</P>
      <List>
        <li>The curve’s shape: one smooth segment, built from your terms.</li>
        <li>The wrapper’s supply, equal to the escrow, and its mint rights, held by the Aegis program.</li>
        <li>The sale fee: flat at {f.saleFee}, collected only in the sale’s currency.</li>
        <li>No pool liquidity that can be withdrawn on day one.</li>
      </List>
      <H2 id="asset-limits">Asset limits</H2>
      <Table
        caption="Asset limits"
        head={["Field", "Limit"]}
        rows={[
          ["Name", "Up to 32 characters"],
          ["Symbol", "Up to 9 characters, so the wrapper’s c fits"],
          ["Decimals", "6 to 9, the range Meteora accepts. The wrapper gets the same."],
          ["Offering documents", <>A <Code>https://</Code> link of up to 200 characters</>],
        ]}
      />
    </>
  ),
};

export const manage: DocPage = {
  slug: "manage",
  group: "For issuers",
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
          Tick wallets under <UI>Holders who can’t redeem yet</UI>, the people who hold the wrapper but aren’t approved. Or paste addresses under{" "}
          <UI>Wallets to approve</UI> and select <UI>Add</UI> for each.
        </Step>
        <Step title={<>Select <UI>Approve selected</UI> or <UI>Approve all</UI> and approve once in your wallet.</>} result={<>the wallets in <UI>The register</UI> with the status <UI>Active</UI>.</>} />
      </Steps>
      <P>To take a wallet off the register, select <UI>Remove…</UI> next to it. It can no longer receive the security; what it already holds stays with it.</P>

      <H2 id="collect">Collect your money</H2>
      <P>After graduation, the <UI>Money</UI> tab lists what you can collect and where.</P>
      <Table
        caption="What an issuer can collect"
        head={["Source", "Where to collect it"]}
        rows={[
          ["Your raise", <>Select <UI>Collect</UI> on the Money tab. This is your cash share of the raise, paid in the sale’s currency. A raise in SOL arrives as plain SOL.</>],
          ["Unsold stock", <>Select <UI>Collect</UI>. Your wallet must be on the register; the console tells you if it isn’t.</>],
          ["Trading fees from the pool", "On Meteora’s site, where your pool position lives."],
          ["Pool liquidity that unlocks", "On Meteora’s site, as each 30-day period is released."],
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
