/**
 * Graduation: finishing the sale, moving to the AMM, and settling the unsold allocation.
 *
 * Three distinct things happen, and only the first is automatic:
 *
 *  1. The buy that reaches the raise target ends the sale, inside that same transaction, and
 *     Meteora permanently strips the transfer hook from cRWA.
 *  2. Someone — anyone — calls Meteora's migration to build the AMM pool.
 *  3. Aegis settles: the wrapper the curve never sold is burned and the matching asset is
 *     recorded as the issuer's, so total supply keeps meaning what it claims. The asset stays in
 *     the vault for the issuer to claim, so settling — and opening the bridge — never depends on
 *     the issuer being registered. Every test here runs with an issuer who never registered.
 *
 * Everything runs against the Meteora and DAMM v2 binaries dumped from mainnet, using a real
 * Meteora-owned config account, so migration either genuinely works or the test fails.
 */
import { assert } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
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
import {
  DAMM_V2_DYNAMIC_CONFIG,
  SWAP_MODE,
  withdrawLeftoverIx,
  dammV2,
  migrateDammV2Ix,
  swapWithTransferHookIx,
} from "./meteora";
import * as upside from "./upside";

/** Small enough that a handful of buys can finish the sale. */
const TARGET_RAISE = 10_000_000_000n; // 10,000 quote tokens at 6dp
const BUYER_FUNDING = 60_000_000_000n;

async function liveMarket(env: Env) {
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
        args: defaultConfigArgs({ targetRaise: TARGET_RAISE }),
      }),
    ],
    [env.issuer, meteoraConfig]
  );

  const crwaMint = Keypair.generate();
  env.sendOk(
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

  const buyer = env.outsider;
  const buyerQuote = getAssociatedTokenAddressSync(
    quote.publicKey,
    buyer.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );
  const buyerCrwa = getAssociatedTokenAddressSync(
    crwaMint.publicKey,
    buyer.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  env.sendOk(
    [
      createAssociatedTokenAccountInstruction(
        env.admin.publicKey,
        buyerQuote,
        buyer.publicKey,
        quote.publicKey,
        TOKEN_PROGRAM_ID
      ),
      createMintToInstruction(
        quote.publicKey,
        buyerQuote,
        env.admin.publicKey,
        BUYER_FUNDING,
        [],
        TOKEN_PROGRAM_ID
      ),
      createAssociatedTokenAccountInstruction(
        env.admin.publicKey,
        buyerCrwa,
        buyer.publicKey,
        crwaMint.publicKey,
        TOKEN_2022_PROGRAM_ID
      ),
    ],
    [env.admin]
  );

  const pool = Env.meteoraPool(
    meteoraConfig.publicKey,
    crwaMint.publicKey,
    quote.publicKey
  );

  return {
    mint,
    quote,
    meteoraConfig,
    crwaMint,
    buyer,
    buyerQuote,
    buyerCrwa,
    pool,
    baseVault: Env.meteoraTokenVault(crwaMint.publicKey, pool),
    quoteVault: Env.meteoraTokenVault(quote.publicKey, pool),
  };
}

type Market = Awaited<ReturnType<typeof liveMarket>>;

function buy(env: Env, m: Market, amountIn: bigint, swapMode?: number) {
  return env.send(
    [
      Env.computeBudget(),
      swapWithTransferHookIx({
        config: m.meteoraConfig.publicKey,
        pool: m.pool,
        inputTokenAccount: m.buyerQuote,
        outputTokenAccount: m.buyerCrwa,
        baseVault: m.baseVault,
        quoteVault: m.quoteVault,
        baseMint: m.crwaMint.publicKey,
        quoteMint: m.quote.publicKey,
        payer: m.buyer.publicKey,
        tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        poolAuthority: Env.meteoraPoolAuthority(),
        eventAuthority: Env.meteoraEventAuthority(),
        hookProgram: env.aegisHookProgramId(),
        extraAccountMetaList: Env.extraAccountMetaList(m.crwaMint.publicKey),
        amountIn,
        swapMode,
      }),
    ],
    [m.buyer]
  );
}

/**
 * Buys until the raise target is reached, which is what ends the sale.
 *
 * Done in chunks rather than one large buy: the 1% fee is taken from the quote side, so the
 * amount reaching the reserve is always less than the amount spent, and a single buy sized at
 * the target would fall short. Chunking also avoids asking the curve to absorb more than it can.
 */
function completeTheSale(env: Env, m: Market) {
  // Deliberately more than the target. `PartialFill` takes only what the curve can still
  // absorb, so the final purchase of a sale succeeds instead of reverting for overshooting —
  // which an `ExactIn` buy sized past the remaining capacity would do.
  expectSuccess(buy(env, m, TARGET_RAISE * 2n, SWAP_MODE.PartialFill));
  assert.isTrue(saleIsOver(env, m), "the sale should have completed");
}

/**
 * The sale ending is observable without reading Meteora's state: it is the moment Meteora
 * permanently strips the transfer hook from cRWA.
 */
function saleIsOver(env: Env, m: Market): boolean {
  const hook = getTransferHook(readMint(env, m.crwaMint.publicKey));
  return !hook || hook.programId.equals(PublicKey.default);
}

function migrate(env: Env, m: Market, payer = env.admin) {
  const first = Keypair.generate();
  const second = Keypair.generate();
  return env.send(
    [
      Env.computeBudget(),
      migrateDammV2Ix({
        virtualPool: m.pool,
        config: m.meteoraConfig.publicKey,
        dbcPoolAuthority: Env.meteoraPoolAuthority(),
        dammPool: dammV2.pool(
          DAMM_V2_DYNAMIC_CONFIG,
          m.crwaMint.publicKey,
          m.quote.publicKey
        ),
        firstPositionNftMint: first.publicKey,
        secondPositionNftMint: second.publicKey,
        baseMint: m.crwaMint.publicKey,
        quoteMint: m.quote.publicKey,
        dbcBaseVault: m.baseVault,
        dbcQuoteVault: m.quoteVault,
        payer: payer.publicKey,
        tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      }),
    ],
    [payer, first, second]
  );
}

function readMint(env: Env, mint: PublicKey) {
  const acc = env.svm.getAccount(mint)!;
  return unpackMint(
    mint,
    { ...acc, data: Buffer.from(acc.data) } as any,
    TOKEN_2022_PROGRAM_ID
  );
}

function balance(env: Env, account: PublicKey, program: PublicKey): bigint {
  const acc = env.svm.getAccount(account);
  if (!acc) return 0n;
  return unpackAccount(
    account,
    { ...acc, data: Buffer.from(acc.data) } as any,
    program
  ).amount;
}

describe("graduation", () => {
  describe("the sale ending", () => {
    let env: Env;
    let m: Market;

    before(async () => {
      env = await Env.booted();
      m = await liveMarket(env);
      completeTheSale(env, m);
    });

    // The single most consequential thing Meteora does automatically, and the reason cRWA can
    // never carry lasting compliance: the AMM cannot host a hooked mint, so the hook is stripped
    // and its authority set to nobody. Irreversible.
    it("permanently strips the hook from cRWA", () => {
      const hook = getTransferHook(readMint(env, m.crwaMint.publicKey));
      const programId = hook?.programId?.toBase58();
      assert.isTrue(
        !hook || programId === PublicKey.default.toBase58(),
        `expected the hook to be revoked, found ${programId}`
      );
    });

    it("stops further trading", () => {
      // With the curve complete there is nothing left to sell on it.
      expectFailure(buy(env, m, 1_000_000n));
    });

    it("has not yet moved anything to the AMM", () => {
      // The sale ending and the move to the AMM are separate events; until someone calls the
      // migration the tokens simply sit there.
      const dammPool = dammV2.pool(
        DAMM_V2_DYNAMIC_CONFIG,
        m.crwaMint.publicKey,
        m.quote.publicKey
      );
      assert.isFalse(env.exists(dammPool));
    });
  });

  describe("migrating to the AMM", () => {
    let env: Env;
    let m: Market;

    before(async () => {
      env = await Env.booted();
      m = await liveMarket(env);
      completeTheSale(env, m);
    });

    it("can be called by anyone", () => {
      // The caller receives nothing. Positions go to the config's fee claimer and the pool
      // creator regardless of who pays, which is what makes a public crank safe.
      expectSuccess(migrate(env, m, env.admin));
    });

    it("creates the AMM pool holding both sides", () => {
      const dammPool = dammV2.pool(
        DAMM_V2_DYNAMIC_CONFIG,
        m.crwaMint.publicKey,
        m.quote.publicKey
      );
      assert.isTrue(env.exists(dammPool), "the graduated pool should exist");

      const baseVault = dammV2.tokenVault(m.crwaMint.publicKey, dammPool);
      const quoteVault = dammV2.tokenVault(m.quote.publicKey, dammPool);
      assert.isTrue(balance(env, baseVault, TOKEN_2022_PROGRAM_ID) > 0n);
      assert.isTrue(balance(env, quoteVault, TOKEN_PROGRAM_ID) > 0n);
    });
  });

  describe("settling the unsold allocation", () => {
    let env: Env;
    let m: Market;
    let supplyBefore: bigint;
    let vaultBefore: bigint;

    before(async () => {
      env = await Env.booted();
      m = await liveMarket(env);

      // Deliberately no issuer registration: settlement must not depend on it.

      completeTheSale(env, m);
      expectSuccess(migrate(env, m));

      supplyBefore = readMint(env, m.crwaMint.publicKey).supply;
      vaultBefore = balance(
        env,
        upside.ataFor(m.mint.publicKey, Env.aegisAuthorityPda(m.mint.publicKey)),
        TOKEN_2022_PROGRAM_ID
      );

      expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            await env.finalizeGraduationIx({
              cranker: env.admin.publicKey,
              realRwaMint: m.mint.publicKey,
              crwaMint: m.crwaMint.publicKey,
              quoteMint: m.quote.publicKey,
              meteoraConfig: m.meteoraConfig.publicKey,
            }),
          ],
          [env.admin]
        )
      );
    });

    it("burns the wrapper the curve never sold", () => {
      const supplyAfter = readMint(env, m.crwaMint.publicKey).supply;
      assert.isTrue(
        supplyAfter < supplyBefore,
        "unsold wrapper should have been destroyed"
      );
    });

    it("records the matching asset as the issuer's, without moving it", () => {
      const burned = supplyBefore - readMint(env, m.crwaMint.publicKey).supply;
      assert.isTrue(burned > 0n);
      assert.equal(
        env.launch(m.mint.publicKey).issuerUnsold.toString(),
        burned.toString(),
        "the issuer is owed exactly the asset behind their unsold stock"
      );
      const issuerAta = upside.ataFor(m.mint.publicKey, env.issuer.publicKey);
      assert.isFalse(env.exists(issuerAta), "nothing was sent to the issuer");
    });

    it("leaves the peg exact", () => {
      const supply = readMint(env, m.crwaMint.publicKey).supply;
      const vault = balance(
        env,
        upside.ataFor(m.mint.publicKey, Env.aegisAuthorityPda(m.mint.publicKey)),
        TOKEN_2022_PROGRAM_ID
      );
      const launch = env.launch(m.mint.publicKey);
      const owed = BigInt(launch.issuerUnsold.toString());
      assert.equal(vault.toString(), (supply + owed).toString());
      assert.equal(vault, vaultBefore, "no asset left the vault");

      assert.equal(launch.realRwaLocked.toString(), vault.toString());
      assert.equal(launch.crwaMinted.toString(), supply.toString());
    });

    it("leaves Aegis holding no wrapper", () => {
      // Anything left here would be tradable stock Aegis has no business owning.
      const aegisCrwa = upside.ataFor(
        m.crwaMint.publicKey,
        Env.aegisAuthorityPda(m.mint.publicKey)
      );
      assert.equal(balance(env, aegisCrwa, TOKEN_2022_PROGRAM_ID), 0n);
    });

    it("marks the launch graduated", () => {
      assert.deepEqual(env.launch(m.mint.publicKey).stage, { graduated: {} });
    });

    it("cannot be run twice", async () => {
      expectAnchorError(
        env.send(
          [
            Env.computeBudget(),
            await env.finalizeGraduationIx({
              cranker: env.admin.publicKey,
              realRwaMint: m.mint.publicKey,
              crwaMint: m.crwaMint.publicKey,
              quoteMint: m.quote.publicKey,
              meteoraConfig: m.meteoraConfig.publicKey,
            }),
          ],
          [env.admin]
        ),
        "InvalidLaunchStage"
      );
    });
  });

  // Meteora's `withdraw_leftover` takes no signer, so a stranger can call it at any point after
  // migration. Settlement has to survive that, or anyone could brick a launch — and with it the
  // bridge — for the price of one transaction.
  describe("when a stranger collects the leftover first", () => {
    let env: Env;
    let m: Market;
    let stranger: Keypair;

    before(async () => {
      env = await Env.booted();
      m = await liveMarket(env);
      // Someone with no involvement in the launch at all — not the buyer, not the issuer.
      stranger = Keypair.generate();
      env.svm.airdrop(stranger.publicKey, 10n * 1_000_000_000n);

      // No issuer registration here either.

      completeTheSale(env, m);
      expectSuccess(migrate(env, m));

      // The griefer needs the receiving account to exist; creating it is permissionless too.
      const aegisAuthority = Env.aegisAuthorityPda(m.mint.publicKey);
      env.sendOk(
        [
          upside.ix.createAta(
            stranger.publicKey,
            m.crwaMint.publicKey,
            aegisAuthority
          ),
        ],
        [stranger]
      );

      expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            withdrawLeftoverIx({
              poolAuthority: Env.meteoraPoolAuthority(),
              config: m.meteoraConfig.publicKey,
              virtualPool: m.pool,
              tokenBaseAccount: upside.ataFor(m.crwaMint.publicKey, aegisAuthority),
              baseVault: m.baseVault,
              baseMint: m.crwaMint.publicKey,
              leftoverReceiver: aegisAuthority,
              tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
              eventAuthority: Env.meteoraEventAuthority(),
            }),
          ],
          [stranger]
        )
      );
    });

    it("sends the tokens to Aegis anyway, not to the stranger", () => {
      // Meteora forces the destination to the recorded leftover receiver, so the only thing a
      // stranger can accomplish is paying our transaction fee for us.
      const aegisCrwa = upside.ataFor(
        m.crwaMint.publicKey,
        Env.aegisAuthorityPda(m.mint.publicKey)
      );
      assert.isTrue(balance(env, aegisCrwa, TOKEN_2022_PROGRAM_ID) > 0n);
      const strangerCrwa = upside.ataFor(
        m.crwaMint.publicKey,
        stranger.publicKey
      );
      assert.equal(
        balance(env, strangerCrwa, TOKEN_2022_PROGRAM_ID),
        0n,
        "the stranger gains nothing; they only paid our transaction fee"
      );
    });

    it("still settles, and the peg still balances", async () => {
      expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            await env.finalizeGraduationIx({
              cranker: env.admin.publicKey,
              realRwaMint: m.mint.publicKey,
              crwaMint: m.crwaMint.publicKey,
              quoteMint: m.quote.publicKey,
              meteoraConfig: m.meteoraConfig.publicKey,
            }),
          ],
          [env.admin]
        )
      );

      const supply = readMint(env, m.crwaMint.publicKey).supply;
      const vault = balance(
        env,
        upside.ataFor(m.mint.publicKey, Env.aegisAuthorityPda(m.mint.publicKey)),
        TOKEN_2022_PROGRAM_ID
      );
      const owed = BigInt(env.launch(m.mint.publicKey).issuerUnsold.toString());
      assert.isTrue(owed > 0n, "the stranger's collection is still credited to the issuer");
      assert.equal(vault.toString(), (supply + owed).toString());
      assert.deepEqual(env.launch(m.mint.publicKey).stage, { graduated: {} });
    });
  });

  describe("ordering and access", () => {
    let env: Env;
    let m: Market;

    beforeEach(async () => {
      env = await Env.booted();
      m = await liveMarket(env);
    });

    const finalize = async (cranker = env.admin) =>
      env.send(
        [
          Env.computeBudget(),
          await env.finalizeGraduationIx({
            cranker: cranker.publicKey,
            realRwaMint: m.mint.publicKey,
            crwaMint: m.crwaMint.publicKey,
            quoteMint: m.quote.publicKey,
            meteoraConfig: m.meteoraConfig.publicKey,
          }),
        ],
        [cranker]
      );

    // Meteora only releases the leftover once the graduated pool exists, which is what forces
    // settlement to come after migration rather than Aegis having to police the order itself.
    it("refuses before the sale has even finished", async () => {
      expectFailure(await finalize());
    });

    it("refuses after the sale ends but before migration", async () => {
      completeTheSale(env, m);
      expectFailure(await finalize());
    });

    // An earlier version sent the unsold asset to the issuer here, so an unregistered issuer
    // kept the bridge shut forever. Settlement no longer moves any Real RWA.
    it("does not need the issuer to be a registered holder", async () => {
      completeTheSale(env, m);
      expectSuccess(migrate(env, m));
      expectSuccess(await finalize());
      assert.deepEqual(env.launch(m.mint.publicKey).stage, { graduated: {} });
    });

    // Settlement moves no Real RWA, so the issuer's registry controls cannot hold it back.
    // They still govern every transfer out of the vault afterwards.
    it("is not held back by a paused registry", async () => {
      completeTheSale(env, m);
      expectSuccess(migrate(env, m));
      env.sendOk(
        [await upside.ix.pause(m.mint.publicKey, env.issuer.publicKey, true)],
        [env.issuer]
      );
      expectSuccess(await finalize());
      assert.deepEqual(env.launch(m.mint.publicKey).stage, { graduated: {} });
    });
  });
});
