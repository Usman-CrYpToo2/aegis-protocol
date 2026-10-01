import { MAX_HOLDERS } from "../../chain/issue";
import { EXAMPLE, ceilingLabel, ceilings, gradDeposit, type DocPage } from "../shared";
import { Callout, Code, CurveFigure, DocLink, G, H2, Lede, Lifecycle, List, P, SupplyBar, Table, TokenModel, TwoMarkets, UI } from "../ui";

const GROUP = "How Aegis works";
const SALE_TYPE_USE: Record<string, string> = {
  "Fixed par": "Instruments sold at a set value, such as notes and bills. The price is meant to barely move.",
  "Book building": "A real but bounded price range, like the range an offering is marketed in.",
  "Growth capital": "The widest band Aegis allows, for assets whose value depends most on demand.",
};

export const priceDiscovery: DocPage = {
  slug: "price-discovery",
  group: GROUP,
  title: "Price discovery on the curve",
  summary: "How Meteora’s Dynamic Bonding Curve sets the price during the sale, inside limits Aegis enforces.",
  body: (f) => (
    <>
      <Lede>
        During the sale, buyers set the price. Aegis runs every sale on Meteora’s Dynamic Bonding Curve: the price rises with each purchase and
        falls with each sale, along a curve that is fixed before the sale opens and that nobody can change.
      </Lede>

      <H2 id="why">Why a curve for a real-world asset</H2>
      <P>
        A traditional offering finds its price through book-building: a bank collects orders at different prices, then sets one issue price and
        decides who gets what. A <G term="Bonding curve">bonding curve</G> does the same job in public. Every order fills straight away, at a
        price set by a formula everyone can read, and nobody allocates. The issuer doesn’t need to put up any money to start the market: the
        buyers’ payments are the market.
      </P>

      <H2 id="how-price-moves">How the price moves</H2>
      <P>
        The sale is a virtual pool. When you buy, your payment goes into the pool and the price moves up the curve, so each next wrapper costs a
        little more. When you sell, wrappers go back and the price moves down. The curve is a constant-product formula, the same model as an
        ordinary trading pool.
      </P>
      <CurveFigure open={`${EXAMPLE.open} USDC`} close={`${EXAMPLE.close} USDC`} ceiling={EXAMPLE.ceiling} quote="USDC" />
      <P>Because the price rises as people buy, the last buyer pays more than the first. Early buyers take the risk of a sale that may not fill, and pay less for it.</P>

      <H2 id="ceiling">The ceiling: how far the price may rise</H2>
      <P>Each launch picks a sale type, and each type has a ceiling: the most the price may rise over the sale, relative to the opening price. The issuer chooses how far to go within it.</P>
      <Table
        caption="Sale types"
        head={["Sale type", "Ceiling", "Meant for"]}
        rows={ceilings.map((c) => [c.label, ceilingLabel(c.multiple), SALE_TYPE_USE[c.label] ?? ""])}
      />
      <P>
        The program enforces the ceiling, not the app. Meteora allows a curve of up to 16 segments, each with its own shape. Aegis doesn’t accept a
        curve from the issuer at all: it builds one smooth segment from three numbers, the opening price, how far the price may rise and the raise
        target. A hidden price spike or a thin patch where the price jumps needs a shape, and one smooth segment has none.
      </P>

      <H2 id="fee">One flat fee</H2>
      <P>
        Every trade on the curve pays {f.saleFee}, the same for the first buyer and the last. Many launchpads start with a high fee that decays to
        stop bots; Aegis deliberately doesn’t, because a regulated instrument should cost the same to buy at any moment. The fee is collected only
        in the currency buyers pay with, so it can never take wrappers out of the pool.
      </P>

      <H2 id="example">A worked example</H2>
      <P>These numbers are computed by the same planner the launch form uses.</P>
      <Table
        caption="Example sale"
        head={["", "Value"]}
        rows={[
          ["Supply issued", `${EXAMPLE.supply} units`],
          ["Sale type", `Book building, ceiling ${EXAMPLE.ceiling}`],
          ["Opening price", `${EXAMPLE.open} USDC`],
          ["May rise to", `${EXAMPLE.rise} the opening price`],
          ["Raise target", `${EXAMPLE.raise} USDC`],
          ["Wrappers sold", EXAMPLE.sold],
          ["Average price paid", `${EXAMPLE.average} USDC`],
          ["Price of the last wrapper", `${EXAMPLE.close} USDC`],
        ]}
      />
      <P>Where the {EXAMPLE.supply} units end up:</P>
      <SupplyBar parts={[
        { label: "sold on the curve", value: EXAMPLE.sold, share: EXAMPLE.shares.sold, tone: "bg-blue" },
        { label: "paired with the raise in the pool", value: EXAMPLE.poolBase, share: EXAMPLE.shares.pool, tone: "bg-ox" },
        { label: "unsold, burned at graduation", value: EXAMPLE.unsold, share: EXAMPLE.shares.unsold, tone: "bg-track" },
      ]} />
      <Callout>
        In this example the supply is far larger than the sale needs, so most of it goes unsold. The security behind unsold wrappers stays in the
        escrow and is owed to the issuer. An issuer can also issue only what the sale needs: the launch form warns when a supply is too small for
        the terms.
      </Callout>

      <H2 id="selling">Selling during the sale</H2>
      <P>While the sale is open, you can sell wrappers back to the curve at its current price, minus the fee. Nobody can stop you; the curve always has the money buyers paid in.</P>

      <H2 id="no-fill">If the sale doesn’t fill</H2>
      <P>
        A sale has no deadline. If it never reaches its target, it stays open, and buyers can keep buying or sell back at the curve’s price. Once
        anyone holds a wrapper, the issuer can no longer cancel the launch or take the security back, because it backs those wrappers.
      </P>

      <H2 id="last-purchase">The purchase that completes the sale</H2>
      <P>
        The app sends purchases as a partial fill: if you ask for more than the sale has left, you buy what is left at the curve’s price and keep the
        rest of your money. The sale therefore closes exactly at its target, and your purchase also graduates it. See{" "}
        <DocLink to="/docs/graduation">Graduation to the pool</DocLink>.
      </P>
    </>
  ),
};

export const graduation: DocPage = {
  slug: "graduation",
  group: GROUP,
  title: "Graduation to the pool",
  summary: "How a finished sale becomes a permanent Meteora DAMM v2 pool, who runs it, and what moves where.",
  body: (f) => (
    <>
      <Lede>Graduation turns a finished sale into a permanent market. It happens once per launch, at the price the sale discovered, and no one can block it.</Lede>

      <H2 id="trigger">What starts it</H2>
      <P>
        The purchase that brings the money raised to the target completes the curve. Trading on the curve stops at once, and Meteora permanently
        removes the wrapper’s transfer checks so it can trade in an ordinary pool. From here, three steps finish the job.
      </P>
      <Table
        caption="Graduation steps"
        head={["Step", "What happens", "Program"]}
        rows={[
          ["1 · Curve complete", "Curve trading stops and the wrapper’s transfer checks are removed for good.", "Meteora, inside the last purchase"],
          ["2 · Migration", "Meteora creates the DAMM v2 pool from the raise and matching wrappers, locks the liquidity and hands each owner a position.", <Code>migration_damm_v2</Code>],
          ["3 · Settlement", "Aegis burns the wrappers the sale didn’t sell, records the security behind them as owed to the issuer, and opens the bridge.", <Code>finalize_graduation</Code>],
        ]}
      />

      <H2 id="who">Who runs it</H2>
      <P>
        Steps 2 and 3 are open to anyone. On mainnet, Meteora runs migration keepers for some currencies; elsewhere someone has to send them. Aegis
        doesn’t rely on a keeper: in the app, the buyer whose purchase completes the sale approves the purchase and both steps together, once. If
        that doesn’t happen, the asset page shows <UI>Graduate this sale</UI> to every visitor. Whoever graduates pays about {gradDeposit} SOL in
        deposits for the new pool’s accounts.
      </P>
      <P>No step depends on the issuer, and settlement moves no security, so a paused or misconfigured register can’t hold graduation back.</P>

      <H2 id="pool">What goes into the pool</H2>
      <List>
        <li><strong className="text-ink">From the raise:</strong> everything except the issuer’s cash share ({f.cash}, chosen with the terms).</li>
        <li><strong className="text-ink">Wrappers:</strong> as many as that money buys at the sale’s final price.</li>
        <li><strong className="text-ink">Meteora’s fee:</strong> 0.2% of both sides, taken as the pool is created.</li>
      </List>
      <P>
        Because the pool is seeded at the final price, trading continues where the sale ended. In the{" "}
        <DocLink to="/docs/price-discovery#example">example</DocLink>, the pool opens with {EXAMPLE.poolQuote} USDC and {EXAMPLE.poolBase} wrappers at{" "}
        {EXAMPLE.close} USDC, and the issuer collects {EXAMPLE.cash} USDC.
      </P>

      <H2 id="liquidity">Who owns the pool, and the locks</H2>
      <P>Meteora gives the pool’s liquidity to two owners as DAMM v2 positions. Neither can withdraw anything on day one.</P>
      <Table
        caption="Pool liquidity"
        head={["Owner", "Share", "Lock"]}
        rows={[
          ["Aegis", f.aegisLp, "Locked forever. It keeps a market open for holders who can’t use the bridge."],
          ["The issuer", f.issuerLp, `Locked forever, released in 30-day periods over ${f.vesting}, or a mix, as chosen with the terms. Releases begin one period after graduation.`],
        ]}
      />
      <P>Locked liquidity still earns its share of the pool’s trading fees. The issuer collects fees and released liquidity on Meteora’s site, where their position lives.</P>

      <H2 id="unsold">Unsold wrappers</H2>
      <P>
        Settlement burns every wrapper the sale didn’t sell, so the wrapper supply only counts wrappers people hold. The security behind them stays
        in the escrow, owed to the issuer, who claims it once their wallet is on the register. That claim pays only from what the escrow holds
        above the wrapper supply, so holders are always covered first.
      </P>

      <H2 id="after">After graduation</H2>
      <List>
        <li>The wrapper trades on its DAMM v2 pool, at a fee of {f.poolFee} set by the issuer. The asset page links to it.</li>
        <li>Approved holders can redeem and deposit through the bridge.</li>
        <li>The curve is closed for good.</li>
      </List>
    </>
  ),
};

export const tokens: DocPage = {
  slug: "tokens",
  group: GROUP,
  title: "The two tokens and the bridge",
  summary: "How the security and the wrapper differ, how the bridge connects them, and why their prices stay together.",
  body: () => (
    <>
      <Lede>Every Aegis asset exists as two tokens. They are equal in value by construction and differ in one thing: who may hold them.</Lede>
      <TokenModel />
      <Table
        caption="The two tokens compared"
        head={["", "The security", "The wrapper"]}
        rows={[
          ["What it is", "The legal claim on the asset", "A token backed one for one by the security in escrow"],
          ["Who can hold it", "Only wallets the issuer approved", "Anyone"],
          ["Who created it", "Aegis, through Upside, for the issuer", "Meteora, when the sale opens"],
          ["Who can create more", "Nobody past its supply cap. Raising the cap is an issuer action in Upside, and public", "Only the Aegis program, and only against a deposit of the security"],
          ["Transfer checks", "Upside’s rules on every transfer, permanently", "None after the sale. Meteora removes them when the sale completes"],
          ["Where it moves", "Between approved wallets and the escrow", "On the curve, then on its Meteora pool, and to any wallet"],
        ]}
      />

      <H2 id="model">Transferable, but gated</H2>
      <P>
        Institutional tokenisation platforms call this model “transferable but gated”: the token circulates freely, while issuing and redeeming
        require approval. Aegis applies it to every launch:
      </P>
      <TwoMarkets />
      <Callout kind="warn" title="Why the wrapper can’t stay restricted">
        When a sale completes, Meteora permanently removes the wrapper’s transfer checks, for every pool, so it can trade in DAMM v2. No launchpad
        on Meteora can keep a wrapper restricted after graduation. Aegis puts the checks where they hold: on the security itself.
      </Callout>

      <H2 id="bridge">The bridge</H2>
      <P>After graduation, an approved holder can swap between the two tokens on the asset page:</P>
      <List>
        <li><strong className="text-ink">Redeem:</strong> give wrappers, receive the same number of the security from the escrow. The wrappers are burned.</li>
        <li><strong className="text-ink">Deposit:</strong> give the security, receive the same number of new wrappers. The security goes into the escrow.</li>
      </List>
      <P>Both are one for one, with no fee and no price impact. Before releasing anything, Aegis reads the redeemer’s registration itself rather than relying on the token’s own checks.</P>

      <H2 id="price">Why the prices stay together</H2>
      <P>The wrapper trades on an open market, so its price can drift from the asset’s value. The bridge pulls it back, because anyone approved can profit from a gap, and closing the gap is how they profit.</P>
      <Callout title="Example">
        Say one TWRA is worth 1.00 USDC and cTWRA trades at 0.95. An approved holder buys 1,000 cTWRA for 950 USDC, redeems them for 1,000 TWRA
        and keeps the difference; their buying lifts the price. If cTWRA trades above 1.00, a holder deposits TWRA and sells the new cTWRA, which
        brings the price down. Redeeming puts a floor under the price; depositing puts a ceiling on it.
      </Callout>
    </>
  ),
};

export const escrow: DocPage = {
  slug: "escrow",
  group: GROUP,
  title: "Escrow and backing",
  summary: "Where the security behind every wrapper is held, how the program keeps the books, and what happens if the backing falls short.",
  body: () => (
    <>
      <Lede>Every wrapper is backed by one unit of the security, held in an escrow the Aegis program controls. This page explains how it is filled, how it is checked and what happens if it ever falls short.</Lede>

      <H2 id="what">What the escrow is</H2>
      <P>
        Each launch has its own escrow: a token account for the security, owned by the launch’s Aegis authority. That authority is a program
        address with no private key, so no person can sign for it. Only the Aegis program can move the security out, and only through the rules
        below.
      </P>

      <H2 id="filled">How it is filled</H2>
      <List ordered>
        <li>Before anything is sold, the program mints the whole supply of the security straight into the escrow, using the issuer’s minting role. The escrow must be empty first, and the supply cap must equal the issue.</li>
        <li>When the sale opens, Meteora mints exactly that many wrappers into its pool. Aegis reads them back and cancels the launch unless the counts match, the decimals match, mint rights sit with Aegis and nobody can freeze the wrapper.</li>
        <li>After that, wrappers only appear when someone deposits the security, and only disappear when someone redeems or burns them.</li>
      </List>

      <H2 id="rule">The rule: at least, not equal</H2>
      <P>
        The program’s rule is that the escrow holds <em>at least</em> as many units as there are wrappers. It can hold more: the issuer’s unsold
        stock waits there, someone may send the security in, or a holder may burn their own wrappers. None of that harms anyone. Less is the
        failure case.
      </P>
      <P>The launch record keeps both numbers. After every bridge move, the program re-reads the real escrow balance and wrapper supply from the chain rather than trusting its own arithmetic, then checks the rule.</P>

      <H2 id="short">If the backing falls short</H2>
      <P>
        The issuer keeps the legal power to move or burn the security from any account, including the escrow (see{" "}
        <DocLink to="/docs/limits#issuer-powers">Risks and limits</DocLink>). If the escrow ever holds less than the wrappers in circulation:
      </P>
      <List>
        <li>every page shows the backing as <UI>short</UI>, in red, within seconds;</li>
        <li>the bridge refuses every swap, so nobody is paid ahead of anyone else;</li>
        <li>the issuer’s claim on their unsold stock pays only from what the escrow holds above the wrapper supply, so a loss comes out of the issuer’s share first.</li>
      </List>

      <H2 id="verify">Check it yourself</H2>
      <P>On any asset page, the <UI>Proof of backing</UI> tab shows the escrow balance next to the wrapper supply. Both link to the explorer, so you can read them without trusting this website.</P>
    </>
  ),
};

export const compliance: DocPage = {
  slug: "compliance",
  group: GROUP,
  title: "Compliance and the register",
  summary: "How Upside’s programs control who may hold the security, what the issuer controls, and where the checks run.",
  body: () => (
    <>
      <Lede>The security’s compliance runs on Upside’s programs for regulated tokens on Solana. The issuer controls them; Aegis sets them up correctly and checks they still work before it acts.</Lede>

      <H2 id="roles">The issuer’s roles</H2>
      <P>Upside splits control of a security into four roles. At launch, Aegis gives all four to the issuer and keeps none. Upside recommends holding the Reserve Admin role in a multisig wallet, because its powers reach every account.</P>
      <Table
        caption="Upside roles"
        head={["Role", "What it allows"]}
        rows={[
          ["Contract Admin", "Grants and removes roles."],
          ["Reserve Admin", "Mints and burns the security, moves it by force, and changes the supply cap."],
          ["Transfer Admin", "Sets up groups and transfer rules, pauses all transfers, approves holders and freezes wallets."],
          ["Wallets Admin", "Approves holders and freezes or unfreezes wallets."],
        ]}
      />

      <H2 id="groups">Groups and rules</H2>
      <P>
        Upside puts every holder in a group, typically one per regulatory category, and lets the security move only between groups that a rule
        connects. A launch on Aegis starts with two groups and two rules:
      </P>
      <Table
        caption="Groups and rules Aegis sets up"
        head={["Group or rule", "What it is for"]}
        rows={[
          ["Investors group", "Approved holders, including the issuer’s own wallet."],
          ["Escrow group", "The Aegis escrow, and nothing else."],
          ["Investors → Escrow", "Deposits through the bridge."],
          ["Escrow → Investors", "Redemptions through the bridge. Aegis checks this rule is open before it locks the asset, opens the sale and on every swap."],
        ]}
      />
      <P>The issuer can add groups and rules in Upside, for example to let approved holders trade the security with each other. The register holds up to {MAX_HOLDERS.toLocaleString("en-US")} holders.</P>

      <H2 id="approval">What approval means</H2>
      <P>
        Approving a wallet writes a holder record for it in the Investors group. The identity checks behind that decision happen off chain, in the
        issuer’s own process; Aegis doesn’t see or store anyone’s identity. Without the record, a wallet can hold and trade the wrapper but can’t
        receive the security.
      </P>

      <H2 id="where">Where the checks run</H2>
      <List>
        <li><strong className="text-ink">Every move of the security</strong> passes Upside’s transfer checks, permanently.</li>
        <li><strong className="text-ink">Every redemption</strong> is also checked by Aegis directly: it reads the redeemer’s holder record itself before releasing anything.</li>
        <li><strong className="text-ink">The wrapper</strong> isn’t checked. During the sale its checks approve everything; at completion Meteora removes them. See <DocLink to="/docs/tokens#model">Transferable, but gated</DocLink>.</li>
      </List>

      <H2 id="aegis-checks">What Aegis checks before acting</H2>
      <P>Because the issuer can change the register at any time, Aegis re-reads it whenever acting on a broken setup would trap someone’s assets: before locking the asset, before opening the sale, on every swap, on a cancellation and when the issuer claims unsold stock. It refuses if:</P>
      <List>
        <li>transfers are paused, or the security no longer uses Upside’s transfer checks;</li>
        <li>the escrow is frozen, has a delegate, or left the Escrow group;</li>
        <li>the redemption rule is closed or not yet open.</li>
      </List>
    </>
  ),
};

export const lifecycle: DocPage = {
  slug: "lifecycle",
  group: GROUP,
  title: "The launch lifecycle",
  summary: "Every stage a launch passes through, as the app shows it and as the program records it.",
  body: () => (
    <>
      <Lede>A launch’s stage is recorded on chain and only ever moves forward. Each stage allows a fixed set of actions, and the program refuses everything else.</Lede>
      <Lifecycle />
      <Table
        caption="Launch stages"
        head={["In the app", "On chain", "What it means", "What can happen next"]}
        rows={[
          ["Preparing · step 1", <Code>TokenCreated</Code>, "The security exists; the register is being set up.", "The issuer locks the supply in escrow"],
          ["Preparing · step 2", <Code>Funded</Code>, "The whole supply is in the escrow.", "The issuer fixes the terms, or cancels"],
          ["Preparing · step 3", <Code>Configured</Code>, "The sale terms are fixed with Meteora.", "The issuer opens the sale, or cancels"],
          ["Offering open", <Code>Live</Code>, "The wrapper exists and the curve is trading.", "Anyone buys or sells; the last purchase completes it"],
          ["Sale filled · one step left", <Code>Live</Code>, "The curve is complete but not yet graduated.", "Anyone graduates it"],
          ["Graduated · bridge open", <Code>Graduated</Code>, "The pool is open and unsold wrappers are burned.", "Trading on Meteora, redemptions and deposits"],
          ["Withdrawn", <Code>Aborted</Code>, "Cancelled before the sale; the security went back to the issuer.", "Nothing"],
        ]}
      />
      <P>In the app, an issuer’s whole path from nothing to <UI>Offering open</UI> is eight transactions behind one wallet approval. See <DocLink to="/docs/launch">How to launch an asset</DocLink>.</P>
    </>
  ),
};
