import { NETWORK_NAME, REPO_URL } from "../../lib/site";
import { ceilingLabel, ceilings, type DocPage } from "../shared";
import { Callout, Code, DocLink, Ext, H2, Lede, List, P, Table, UI } from "../ui";

const GROUP = "Trust & security";

export const guarantees: DocPage = {
  slug: "guarantees",
  group: GROUP,
  title: "What the program guarantees",
  summary: "Each promise Aegis makes, the code that enforces it, and how to check it yourself.",
  body: (f) => (
    <>
      <Lede>These rules hold for every launch, whoever the issuer is. The Aegis program enforces each one on chain, not this website, and you can check each one yourself.</Lede>
      <Table
        caption="Guarantees and how they are enforced"
        head={["Guarantee", "How the program enforces it", "Check it yourself"]}
        rows={[
          ["Every wrapper is backed", <>Every instruction that moves either token ends by re-reading the escrow and the wrapper supply, and fails if the escrow holds less (<Code>assert_backing</Code>).</>, "Proof of backing tab: escrow balance against wrapper supply, both linked to the explorer."],
          ["Nobody can print wrappers", "When the sale opens, Aegis checks that mint rights went to its own program address, not the issuer, and that nobody can freeze the wrapper. Otherwise the whole launch is cancelled.", "The wrapper’s mint in the explorer: its mint authority is the launch’s Aegis address."],
          ["The supply matches the escrow", "Aegis fills the escrow itself, in one instruction, before the sale. When Meteora creates the wrapper, Aegis checks its supply equals the escrow exactly.", "The Supply figure on the asset page against the security’s mint."],
          ["The price can’t run away", <>Aegis builds the curve itself as one smooth segment, so it can’t hide a spike or a thin patch, and the price can’t rise past the ceiling: {ceilings.map((c) => ceilingLabel(c.multiple)).join(", ")}.</>, "The chart’s dashed ceiling, and Price ceiling in Terms."],
          ["No day-one exit", `No pool liquidity can be withdrawn at graduation. Aegis’s ${f.aegisLp} is locked forever; the issuer’s share is locked forever or released over ${f.vesting}.`, "Where the money goes tab."],
          ["The sale’s terms can’t change", "The fee is flat, collected only in the sale’s currency, and fixed in the sale’s Meteora configuration with every other term.", "Terms tab."],
          ["Holders can always leave", "The redemption path is checked before the asset is locked, before the sale opens and on every swap. A raised supply cap can stop a sale from opening, never a redemption.", "Redeem on the asset page, or read the bridge code."],
          ["Graduation can’t be blocked", "Migration and settlement are open to anyone, and settlement moves no security, so no issuer setting can stop them.", "Graduate this sale appears for any visitor once a sale fills."],
        ]}
      />
      <H2 id="read-the-check">Read the check</H2>
      <P>This function ends every instruction that moves either token. If it fails, the whole transaction is undone.</P>
      <pre className="mt-4 max-w-[68ch] overflow-x-auto bg-ink p-5 font-mono text-[13px] leading-[1.8] text-[#E4DECF]">{`pub fn assert_backing(&self) -> Result<()> {
    require_gte!(
        self.real_rwa_locked,   // the security in the escrow
        self.crwa_minted,       // wrappers in existence
        AegisError::BackingShortfall
    );
    Ok(())
}`}</pre>
      <P><Ext href={`${REPO_URL}/blob/main/programs/aegis/src/state/launch.rs`}>See it in the source</Ext>, or read the full design in <Ext href={`${REPO_URL}/blob/main/design.md`}>design.md</Ext>.</P>
    </>
  ),
};

export const limits: DocPage = {
  slug: "limits",
  group: GROUP,
  title: "Risks and limits",
  summary: "What Aegis can’t guarantee, the risks that remain, and what protects you in each case.",
  body: () => (
    <>
      <Lede>A blockchain can prove what happens on chain. It can’t see a building. This page lists what Aegis does not guarantee and the risks that remain, so you can judge them.</Lede>

      <H2 id="real-asset">The real-world asset</H2>
      <P>
        The chain proves that every wrapper is matched by a unit of the security. It can’t prove that the security is matched by a real building,
        bond or share. That link is the issuer’s legal promise, in the offering documents linked from each asset page under{" "}
        <UI>Offering documents</UI>. Read them, and judge the issuer as you would off chain.
      </P>

      <H2 id="issuer-powers">The issuer’s legal powers</H2>
      <P>
        Securities law requires an issuer to approve holders, freeze a wallet, pause transfers, and move or burn tokens under a court order. Through
        Upside the issuer keeps all of these, and they reach every account, including the Aegis escrow. Aegis can’t remove them. What it does
        instead:
      </P>
      <List>
        <li>It gives force transfer and burn no button in the app.</li>
        <li>It checks the escrow on every swap. If it ever holds less than the wrappers in circulation, the bridge stops for everyone and every page shows <UI>short</UI> in red.</li>
        <li>A loss comes out of the issuer’s unsold stock first: their claim pays only from what the escrow holds above the wrapper supply.</li>
        <li>Every use of a power is a public transaction.</li>
      </List>

      <H2 id="issuer-settings">Settings the issuer controls</H2>
      <P>
        The issuer owns the register and can close the redemption rule, pause transfers, point the security at different transfer checks, or
        raise its supply cap. Aegis checks these whenever they matter and refuses to act on a broken setup: it won’t lock the asset, open a sale or
        run a swap that nobody could leave. It can’t make the issuer reopen a path they closed.
      </P>

      <H2 id="market">Market risks</H2>
      <List>
        <li><strong className="text-ink">A sale may never fill.</strong> It stays open with no deadline. You can sell back to the curve, at its price at the time.</li>
        <li><strong className="text-ink">The price can fall.</strong> The ceiling limits how high the sale’s price goes, not how low the market goes after.</li>
        <li><strong className="text-ink">The bridge needs approval.</strong> Only approved holders can redeem, so the price pull of the bridge depends on approved holders using it.</li>
      </List>

      <H2 id="free-wrapper">The wrapper is open to anyone</H2>
      <P>
        Meteora removes the wrapper’s transfer checks when a sale completes, so anyone can hold it, anywhere. Identity checks apply when it becomes
        the security. Whether the wrapper may be offered to someone in a given country is a legal question for each issuer.
      </P>

      <H2 id="platform">The platform admin</H2>
      <P>
        The Aegis admin can change fees and limits for new launches, approve or retire currencies, and pause new launches. None of it reaches a sale
        already open: its terms are fixed in its Meteora configuration. The admin holds no power over any security, escrow or wrapper.
      </P>

      <H2 id="software">The software</H2>
      <P>
        Aegis relies on Solana, Meteora and Upside working as published, and a fault in any of them is outside what the Aegis program can prevent.
        The Aegis program has an extensive test suite, including attack tests run against Meteora’s real program, but it has not had an external
        audit. It runs on {NETWORK_NAME}; treat it as test software.
      </P>
    </>
  ),
};

export const roles: DocPage = {
  slug: "roles",
  group: GROUP,
  title: "Roles and permissions",
  summary: "Who can do what in a launch: anyone, approved holders, the issuer, the Aegis admin and the program itself.",
  body: () => (
    <>
      <Lede>Every action in a launch belongs to one party. This page lists them, so you can see exactly who could do what.</Lede>
      <Table
        caption="Who can do what"
        head={["Action", "Who", "Notes"]}
        rows={[
          ["Start a launch", "Anyone", "Pays the launch fee and becomes the issuer."],
          ["Buy or sell on the curve", "Anyone", "While the sale is open."],
          ["Graduate a filled sale", "Anyone", "Pays the new pool’s account deposits."],
          ["Trade the wrapper after graduation", "Anyone", "On its Meteora pool."],
          ["Redeem or deposit", "Approved holders", "One for one, through the bridge."],
          ["Approve or remove holders", "The issuer", "Upside’s Wallets Admin or Transfer Admin role."],
          ["Freeze a wallet, pause transfers", "The issuer", "Upside’s Transfer Admin role (Wallets Admin can also freeze)."],
          ["Mint, burn or force-move the security; change its supply cap", "The issuer", "Upside’s Reserve Admin role. Reaches every account, the escrow included."],
          ["Cancel a launch", "The issuer", "Only before the sale opens."],
          ["Collect cash share and unsold stock", "The issuer", "Unsold stock pays only from the escrow’s excess."],
          ["Mint new wrappers", "The Aegis program only", "Only against a deposit of the security."],
          ["Move the security out of the escrow", "The Aegis program only", "On a redemption, a cancellation or the issuer’s unsold claim, plus the issuer’s legal powers above."],
          ["Change fees and limits, approve currencies, pause new launches", "The Aegis admin", "Never reaches a sale already open."],
          ["Collect Aegis’s fees", "Anyone can send them", "They can only go to the platform’s fee address."],
        ]}
      />
      <Callout>Aegis holds none of the security’s Upside roles. The program address that owns each escrow has no private key, so no person, Aegis’s team included, can sign for it.</Callout>
    </>
  ),
};

export const legal: DocPage = {
  slug: "legal",
  group: GROUP,
  title: "Legal model",
  summary: "What Aegis is and isn’t, what each issuer is responsible for, and what a holder of each token has.",
  body: () => (
    <>
      <Lede>Aegis is software: a set of programs and this website. It doesn’t issue, sell or hold securities. This page explains where the legal responsibilities sit.</Lede>

      <H2 id="issuer">The issuer</H2>
      <P>Each launch has an issuer, the organisation that created the security. The issuer is responsible for:</P>
      <List>
        <li>the asset itself, and the legal structure that ties it to the security;</li>
        <li>the offering documents, linked from the asset page;</li>
        <li>checking investors before approving them, under the rules that apply to it;</li>
        <li>deciding where, and to whom, the security and its wrapper may be offered.</li>
      </List>

      <H2 id="holders">What each holder has</H2>
      <Table
        caption="What each token gives its holder"
        head={["Token", "What it gives you"]}
        rows={[
          ["The security", "The claim on the asset that the issuer’s offering documents describe."],
          ["The wrapper", "A token backed one for one by the security in escrow, which an approved holder can redeem for it. Any rights beyond that are set by the issuer’s documents."],
        ]}
      />

      <H2 id="aegis">What Aegis does and doesn’t do</H2>
      <List>
        <li>It enforces the rules on this page and the guarantees in <DocLink to="/docs/guarantees">What the program guarantees</DocLink>.</li>
        <li>It doesn’t check identities, give investment advice, or vouch for any issuer or asset.</li>
        <li>Its admin has no power over any security, escrow or wrapper.</li>
      </List>
      <Callout kind="warn" title="Test network">Aegis runs on {NETWORK_NAME}. Every asset in it is a test launch. Nothing on this site is an offer of securities or investment advice.</Callout>
    </>
  ),
};
