import { config } from "../../config";
import { NETWORK_NAME } from "../../lib/site";
import { EXAMPLE, type DocPage } from "../shared";
import { Callout, DocLink, Ext, G, H2, Lede, List, P, Paths, Step, Steps, Table, TokenModel, TwoMarkets, UI } from "../ui";

export const overview: DocPage = {
  slug: "",
  group: "Introduction",
  title: "What is Aegis",
  summary: "A launchpad that discovers a real-world asset’s price on Meteora’s bonding curve, then gives it a permanent market, while the security stays compliant.",
  body: (f) => (
    <>
      <Lede>
        Aegis is a launchpad for real-world assets on Solana. It sells an asset through Meteora’s{" "}
        <G term="Bonding curve">bonding curve</G>, so the market discovers its price in public, then moves it into a permanent Meteora pool where
        it trades for good. The legal security stays under its issuer’s compliance rules the whole time.
      </Lede>

      <H2 id="problem">The problem</H2>
      <P>
        A building, a bond or a fund share on a blockchain is still a security. Only holders the issuer approved may own it, so it can’t trade on an
        open market. That leaves tokenised assets with two poor options: sit in approved wallets with no market and no price, or trade freely with
        nothing on chain proving what backs them.
      </P>

      <H2 id="how">How it works, in three steps</H2>
      <Steps>
        <Step title="Discover the price on a bonding curve.">
          The issuer locks the whole security in the Aegis escrow and opens a sale on Meteora’s Dynamic Bonding Curve. Anyone can buy a{" "}
          <G term="Wrapper">wrapper</G> backed one for one by the escrow. Each purchase moves the price up a curve, inside a ceiling the program
          enforces, until the raise target is reached. <DocLink to="/docs/price-discovery">How the curve discovers the price</DocLink>
        </Step>
        <Step title="Graduate to a permanent market.">
          The purchase that reaches the target ends the sale. The money raised and matching wrappers move into a Meteora DAMM v2 pool that opens
          at the price the sale ended on, so the price doesn’t jump. Its liquidity is locked, and the wrapper trades there for good.{" "}
          <DocLink to="/docs/graduation">What happens at graduation</DocLink>
        </Step>
        <Step title="Bridge between the wrapper and the security.">
          From then on, an approved holder can swap wrappers for the security, or back, one for one with no fee. That keeps the wrapper’s price
          tied to the asset’s value. <DocLink to="/docs/tokens">The two tokens and the bridge</DocLink>
        </Step>
      </Steps>

      <H2 id="two-tokens">One asset, two tokens</H2>
      <TokenModel />
      <P>
        The security is the legal claim and only approved wallets can hold it. The wrapper is what trades: its symbol is the security’s with a{" "}
        <UI>c</UI> in front. Every wrapper is backed by one unit of the security in the escrow, and the program checks it on every move.
      </P>

      <H2 id="two-markets">Two markets</H2>
      <P>
        Like tokenised stocks, Aegis separates a gated primary market from an open secondary market. Identity checks happen where the law needs
        them, when someone takes ownership of the security, and nowhere else.
      </P>
      <TwoMarkets />

      <H2 id="example">An example</H2>
      <P>
        An issuer launches {EXAMPLE.supply} units of a building. The sale opens at {EXAMPLE.open} USDC and may rise to {EXAMPLE.rise} on its way
        to a {EXAMPLE.raise} USDC target. Buyers take {EXAMPLE.sold} wrappers, the last ones at {EXAMPLE.close} USDC. At graduation the issuer
        collects {EXAMPLE.cash} USDC, and the pool opens with {EXAMPLE.poolQuote} USDC and {EXAMPLE.poolBase} wrappers at {EXAMPLE.close}. The{" "}
        {EXAMPLE.unsold} wrappers nobody bought are burned. <DocLink to="/docs/price-discovery#example">See the full breakdown</DocLink>
      </P>

      <H2 id="built-on">What Aegis is built on</H2>
      <Table
        caption="The systems Aegis connects"
        head={["Part", "What it does in a launch"]}
        rows={[
          ["Meteora Dynamic Bonding Curve", "Runs the sale and discovers the price."],
          ["Meteora DAMM v2", "The permanent pool the sale graduates into."],
          ["Upside", "The security’s compliance programs: the register, transfer rules and the issuer’s legal powers."],
          ["The Aegis program", "Sets the rules every launch must meet, holds the escrow, checks the backing and runs the bridge."],
        ]}
      />

      <H2 id="next">Where to go next</H2>
      <Paths items={[
        { to: "/docs/try-it", kicker: "New here", title: "Try it in ten minutes", text: "Buy into an offering with test tokens, then check the backing yourself." },
        { to: "/docs/launch", kicker: "Issuers", title: "Launch an asset", text: `From your security to an open sale, with one wallet approval and a ${f.creationFee} fee.` },
        { to: "/docs/guarantees", kicker: "Reviewers", title: "What the program guarantees", text: "Each promise, the code that enforces it, and how to check it." },
      ]} />
      <Callout title="Test network">Aegis runs on {NETWORK_NAME}. Every asset in it is a test launch, and nothing here is an offer of securities or investment advice.</Callout>
    </>
  ),
};

export const tryIt: DocPage = {
  slug: "try-it",
  group: "Introduction",
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
        <Step title={<>Select an asset marked <UI>Offering open</UI>.</>} result="the asset page, with the price, how much has been raised, the curve, and a box to buy." />
        <Step title={<>Select <UI>Connect wallet</UI> and approve in your wallet.</>} />
        <Step title={<>In the buy box, enter <UI>10</UI> in <UI>You pay</UI>.</>} result={<>how many wrappers you receive, under <UI>You receive about</UI>.</>} />
        <Step title={<>Select the blue <UI>Buy</UI> button and approve in your wallet.</>} result={<><UI>Purchase complete</UI>, with what you paid and received. The chart’s marker has moved up the curve.</>} />
      </Steps>

      <H2 id="check">Check the backing yourself</H2>
      <Steps>
        <Step title={<>On the same page, open the <UI>Proof of backing</UI> tab.</>} result="the units held in escrow next to the wrappers in circulation. The escrow holds at least as many." />
        <Step title="Open the escrow vault’s address in the explorer." result="the vault’s balance on a block explorer, outside this website.">
          Every address on the page links to the explorer, so you never have to trust what this site shows.
        </Step>
        <Step title={<>Open <DocLink to="/holdings">My holdings</DocLink>.</>} result={<>your wrappers, with the status <UI>Not approved yet</UI>: the issuer hasn’t approved your wallet to hold the security.</>} />
      </Steps>
      <P>You have bought a wrapper backed by a real security and checked the backing on chain yourself.</P>

      <H2 id="next">Next steps</H2>
      <List>
        <li>To understand why the price moved after your purchase, read <DocLink to="/docs/price-discovery">Price discovery on the curve</DocLink>.</li>
        <li>To swap wrappers for the security after the sale, see <DocLink to="/docs/redeem">How to get approved, redeem and deposit</DocLink>.</li>
        <li>To run a launch of your own, see <DocLink to="/docs/launch">How to launch an asset</DocLink>.</li>
      </List>
    </>
  ),
};
