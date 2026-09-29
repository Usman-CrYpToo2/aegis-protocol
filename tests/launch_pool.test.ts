/**
 * `launch_pool` — launch step 4: open the sale.
 *
 * Meteora creates the cRWA mint inside its own instruction, so the wrapper token does not exist
 * until this point and the checks that matter run *after* the CPI rather than before it.
 *
 * Three of those checks decide whether the protocol's central claim is true: that cRWA supply
 * equals the escrowed asset exactly, that mint authority landed on the Aegis PDA rather than the
 * issuer's wallet, and that the decimals match. Most of this file exists to prove they hold
 * against the real Meteora binary rather than against our idea of what it does.
 */
import { assert } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getTransferHook,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import {
  Env,
  defaultConfigArgs,
  defaultRwaArgs,
  expectAnchorError,
  expectFailure,
  expectSuccess,
} from "./helpers";
import * as upside from "./upside";

/** Everything up to and including step 3, ready for the sale to open. */
async function configuredLaunch(env: Env) {
  const quote = await env.makeSplMint(6);
  env.sendOk([await env.whitelistQuoteTokenIx(quote.publicKey)], [env.admin]);
  const mint = await env.fundedLaunch();
  const meteoraConfig = Keypair.generate();
  env.sendOk(
    [
      await env.createRwaConfigIx({
        issuer: env.issuer.publicKey,
        realRwaMint: mint.publicKey,
        quoteMint: quote.publicKey,
        meteoraConfig: meteoraConfig.publicKey,
        args: defaultConfigArgs(),
      }),
    ],
    [env.issuer, meteoraConfig]
  );
  return { mint, quote, meteoraConfig };
}

function readMint(env: Env, mint: PublicKey) {
  const acc = env.svm.getAccount(mint)!;
  return unpackMint(
    mint,
    { ...acc, data: Buffer.from(acc.data) } as any,
    TOKEN_2022_PROGRAM_ID
  );
}

describe("launch_pool", () => {
  describe("happy path", () => {
    let env: Env;
    let mint: Keypair;
    let quote: Keypair;
    let meteoraConfig: Keypair;
    let crwaMint: Keypair;

    before(async () => {
      env = await Env.booted();
      ({ mint, quote, meteoraConfig } = await configuredLaunch(env));
      crwaMint = Keypair.generate();
      expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            await env.launchPoolIx({
              issuer: env.issuer.publicKey,
              realRwaMint: mint.publicKey,
              quoteMint: quote.publicKey,
              meteoraConfig: meteoraConfig.publicKey,
              crwaMint: crwaMint.publicKey,
            }),
          ],
          [env.issuer, crwaMint]
        )
      );
    });

    // The claim the whole protocol rests on.
    it("mints exactly as much cRWA as there is escrowed asset", () => {
      const args = defaultRwaArgs();
      const crwa = readMint(env, crwaMint.publicKey);
      const vault = env.svm.getAccount(
        upside.ataFor(mint.publicKey, Env.aegisAuthorityPda(mint.publicKey))
      )!;
      const escrowed = unpackAccount(
        PublicKey.default,
        { ...vault, data: Buffer.from(vault.data) } as any,
        TOKEN_2022_PROGRAM_ID
      ).amount;

      assert.equal(crwa.supply.toString(), args.totalSupply.toString());
      assert.equal(crwa.supply.toString(), escrowed.toString());
    });

    // Meteora offers an authority option that hands mint rights to the pool creator. Taking it
    // would let the issuer print unbacked wrapper tokens at will.
    it("puts cRWA mint authority on the Aegis PDA, not the issuer", () => {
      const crwa = readMint(env, crwaMint.publicKey);
      assert.equal(
        crwa.mintAuthority?.toBase58(),
        Env.aegisAuthorityPda(mint.publicKey).toBase58()
      );
      assert.notEqual(
        crwa.mintAuthority?.toBase58(),
        env.issuer.publicKey.toBase58()
      );
    });

    it("leaves cRWA with no freeze authority", () => {
      // A freezable wrapper could be used to strand holders after they have bought.
      assert.isNull(readMint(env, crwaMint.publicKey).freezeAuthority);
    });

    it("matches decimals on both sides", () => {
      const crwa = readMint(env, crwaMint.publicKey);
      const real = readMint(env, mint.publicKey);
      // A mismatch would silently scale the peg by a power of ten on every swap.
      assert.equal(crwa.decimals, real.decimals);
      assert.equal(crwa.decimals, defaultRwaArgs().decimals);
    });

    it("attaches the Aegis hook to cRWA", () => {
      const hook = getTransferHook(readMint(env, crwaMint.publicKey));
      assert.isNotNull(hook);
      assert.equal(
        hook!.programId.toBase58(),
        env.aegisHookProgramId().toBase58()
      );
    });

    // Without this account Token-2022 cannot resolve the hook's accounts, and the pool looks
    // perfectly healthy while every single trade fails.
    it("creates the hook's companion account", () => {
      const metas = Env.extraAccountMetaList(crwaMint.publicKey);
      assert.isTrue(env.exists(metas), "extra-account-metas must exist before any trade");
      const acc = env.svm.getAccount(metas)!;
      assert.equal(
        new PublicKey(acc.owner).toBase58(),
        env.aegisHookProgramId().toBase58()
      );
    });

    it("puts the whole supply in Meteora's vault", () => {
      const pool = Env.meteoraPool(
        meteoraConfig.publicKey,
        crwaMint.publicKey,
        quote.publicKey
      );
      const baseVault = Env.meteoraTokenVault(crwaMint.publicKey, pool);
      const acc = env.svm.getAccount(baseVault)!;
      const parsed = unpackAccount(
        baseVault,
        { ...acc, data: Buffer.from(acc.data) } as any,
        TOKEN_2022_PROGRAM_ID
      );
      assert.equal(
        parsed.amount.toString(),
        readMint(env, crwaMint.publicKey).supply.toString(),
        "any wrapper outside the pool is supply we are not accounting for"
      );
    });

    it("records the launch as Live with a balanced peg", () => {
      const launch = env.launch(mint.publicKey);
      assert.equal(launch.crwaMint.toBase58(), crwaMint.publicKey.toBase58());
      assert.deepEqual(launch.stage, { live: {} });
      assert.equal(
        launch.realRwaLocked.toString(),
        launch.crwaMinted.toString(),
        "the peg ledger becomes meaningful at Live and must balance"
      );
    });

    it("cannot be run twice", async () => {
      const second = Keypair.generate();
      expectAnchorError(
        env.send(
          [
            Env.computeBudget(),
            await env.launchPoolIx({
              issuer: env.issuer.publicKey,
              realRwaMint: mint.publicKey,
              quoteMint: quote.publicKey,
              meteoraConfig: meteoraConfig.publicKey,
              crwaMint: second.publicKey,
            }),
          ],
          [env.issuer, second]
        ),
        "InvalidLaunchStage"
      );
    });
  });

  describe("the compliance gate, re-run", () => {
    let env: Env;
    let mint: Keypair;
    let quote: Keypair;
    let meteoraConfig: Keypair;

    beforeEach(async () => {
      env = await Env.booted();
      ({ mint, quote, meteoraConfig } = await configuredLaunch(env));
    });

    const launch = async () => {
      const crwaMint = Keypair.generate();
      return env.send(
        [
          Env.computeBudget(),
          await env.launchPoolIx({
            issuer: env.issuer.publicKey,
            realRwaMint: mint.publicKey,
            quoteMint: quote.publicKey,
            meteoraConfig: meteoraConfig.publicKey,
            crwaMint: crwaMint.publicKey,
          }),
        ],
        [env.issuer, crwaMint]
      );
    };

    it("opens the sale when nothing has changed", async () => {
      expectSuccess(await launch());
    });

    // Everything checked at funding is still under the issuer's control. Launching into a closed
    // redemption path would create a wrapper nobody can ever unwrap.
    it("refuses if the redemption path was closed after funding", async () => {
      env.sendOk(
        [
          await upside.ix.setRule(
            mint.publicKey,
            env.issuer.publicKey,
            upside.DEFAULT_LAYOUT.vaultGroup,
            upside.DEFAULT_LAYOUT.investorGroup,
            0
          ),
        ],
        [env.issuer]
      );
      expectAnchorError(await launch(), "RedemptionPathClosed");
    });

    it("refuses if transfers were paused after funding", async () => {
      env.sendOk(
        [await upside.ix.pause(mint.publicKey, env.issuer.publicKey, true)],
        [env.issuer]
      );
      expectAnchorError(await launch(), "TransfersPaused");
    });

    it("refuses if the supply cap was raised after funding", async () => {
      const BN = require("bn.js");
      const ix = await upside.accessControlProgram.methods
        .setMaxTotalSupply(
          new BN((BigInt(defaultRwaArgs().totalSupply) * 2n).toString())
        )
        .accountsPartial({
          accessControlAccount: upside.pda.accessControl(mint.publicKey),
          mint: mint.publicKey,
          authorityWalletRole: upside.pda.walletRole(
            mint.publicKey,
            env.issuer.publicKey
          ),
          payer: env.issuer.publicKey,
        })
        .instruction();
      env.sendOk([ix], [env.issuer]);
      expectAnchorError(await launch(), "SupplyCapRaised");
    });

    // The issuer keeps ReserveAdmin on a security and can force tokens out of any account, and
    // Aegis could not be registered as a lockup escrow to gain immunity — see findings-step1.md.
    // So the guarantee is not that the vault cannot be drained, but that a drained vault can
    // never be launched against.
    //
    // The balance is emptied directly rather than by calling Upside's force-transfer: that path
    // additionally requires the hook's extra accounts to be resolved and passed, which is
    // frontend plumbing and would test Upside rather than Aegis.
    it("refuses if the asset is no longer in the vault", async () => {
      const authority = Env.aegisAuthorityPda(mint.publicKey);
      const vault = upside.ataFor(mint.publicKey, authority);
      const acc = env.svm.getAccount(vault)!;
      const data = Buffer.from(acc.data);
      // SPL token account layout: mint (32), owner (32), amount (8).
      data.writeBigUInt64LE(0n, 64);
      env.svm.setAccount(vault, { ...acc, data });

      expectAnchorError(await launch(), "VaultUnderfunded");
    });

    it("refuses if the vault is merely short, not empty", async () => {
      const authority = Env.aegisAuthorityPda(mint.publicKey);
      const vault = upside.ataFor(mint.publicKey, authority);
      const acc = env.svm.getAccount(vault)!;
      const data = Buffer.from(acc.data);
      const short = BigInt(defaultRwaArgs().totalSupply) - 1n;
      data.writeBigUInt64LE(short, 64);
      env.svm.setAccount(vault, { ...acc, data });

      // A single missing atom is still a broken peg.
      expectAnchorError(await launch(), "VaultUnderfunded");
    });
  });

  describe("what the caller cannot substitute", () => {
    let env: Env;
    let mint: Keypair;
    let quote: Keypair;
    let meteoraConfig: Keypair;

    beforeEach(async () => {
      env = await Env.booted();
      ({ mint, quote, meteoraConfig } = await configuredLaunch(env));
    });

    const launchWith = async (over: any) => {
      const crwaMint = Keypair.generate();
      return env.send(
        [
          Env.computeBudget(),
          await env.launchPoolIx({
            issuer: env.issuer.publicKey,
            realRwaMint: mint.publicKey,
            quoteMint: quote.publicKey,
            meteoraConfig: meteoraConfig.publicKey,
            crwaMint: crwaMint.publicKey,
            ...over,
          }),
        ],
        [env.issuer, crwaMint]
      );
    };

    it("rejects a substituted Meteora program", async () => {
      expectAnchorError(
        await launchWith({ dbcProgram: env.outsider.publicKey }),
        "InvalidDbcProgram"
      );
    });

    it("rejects a substituted hook program", async () => {
      expectAnchorError(
        await launchWith({ hookProgram: TOKEN_2022_PROGRAM_ID }),
        "InvalidHookProgram"
      );
    });

    it("rejects a substituted pool authority", async () => {
      expectFailure(await launchWith({ poolAuthority: env.outsider.publicKey }));
    });

    // A config from another launch would carry a different curve and a different fee claimer.
    it("rejects a config belonging to a different launch", async () => {
      const other = await configuredLaunch(env);
      expectAnchorError(
        await launchWith({ meteoraConfig: other.meteoraConfig.publicKey }),
        "WrongMeteoraConfig"
      );
    });

    it("rejects a quote mint the launch was not configured for", async () => {
      const otherQuote = await env.makeSplMint(6);
      expectAnchorError(
        await launchWith({ quoteMint: otherQuote.publicKey }),
        "QuoteMintMismatch"
      );
    });

    it("refuses anyone who is not the launch issuer", async () => {
      const crwaMint = Keypair.generate();
      expectFailure(
        env.send(
          [
            Env.computeBudget(),
            await env.launchPoolIx({
              issuer: env.outsider.publicKey,
              realRwaMint: mint.publicKey,
              quoteMint: quote.publicKey,
              meteoraConfig: meteoraConfig.publicKey,
              crwaMint: crwaMint.publicKey,
            }),
          ],
          [env.outsider, crwaMint]
        )
      );
    });

    it("refuses while the protocol is paused", async () => {
      await env.setPaused(true);
      expectAnchorError(await launchWith({}), "ProtocolPaused");
    });
  });

  describe("ordering", () => {
    it("refuses before the Meteora config exists", async () => {
      const env = await Env.booted();
      const quote = await env.makeSplMint(6);
      env.sendOk([await env.whitelistQuoteTokenIx(quote.publicKey)], [env.admin]);
      const mint = await env.fundedLaunch(); // funded but not configured
      const crwaMint = Keypair.generate();
      const stray = Keypair.generate();
      expectFailure(
        env.send(
          [
            Env.computeBudget(),
            await env.launchPoolIx({
              issuer: env.issuer.publicKey,
              realRwaMint: mint.publicKey,
              quoteMint: quote.publicKey,
              meteoraConfig: stray.publicKey,
              crwaMint: crwaMint.publicKey,
            }),
          ],
          [env.issuer, crwaMint]
        )
      );
    });
  });
});
