/**
 * The bridge: converting between the asset and its wrapper, one for one.
 *
 * This is what makes the wrapper mean anything. Without it cRWA is a token whose price can drift
 * anywhere and whose connection to the real asset is decorative. With it, anyone can arbitrage a
 * discount by redeeming and a premium by depositing, so the market price is tethered.
 *
 * The compliance asymmetry is the point of these tests: the wrapper moves freely, while the
 * asset itself never leaves the compliance layer. Redeeming hands someone a regulated security
 * and is gated; depositing is not, because anyone holding the asset was already approved.
 */
import { assert } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  unpackMint,
} from "@solana/spl-token";
import {
  Env,
  defaultConfigArgs,
  expectAnchorError,
  expectFailure,
  expectSuccess,
} from "./helpers";
import {
  DAMM_V2_DYNAMIC_CONFIG,
  SWAP_MODE,
  dammV2,
  migrateDammV2Ix,
  swapWithTransferHookIx,
} from "./meteora";
import * as upside from "./upside";

const TARGET_RAISE = 10_000_000_000n;
const LAYOUT = upside.DEFAULT_LAYOUT;

function readMint(env: Env, mint: PublicKey) {
  const acc = env.svm.getAccount(mint)!;
  return unpackMint(
    mint,
    { ...acc, data: Buffer.from(acc.data) } as any,
    TOKEN_2022_PROGRAM_ID
  );
}

function balance(env: Env, account: PublicKey): bigint {
  const acc = env.svm.getAccount(account);
  if (!acc) return 0n;
  // amount sits at offset 64 in the SPL token account layout
  return Buffer.from(acc.data).readBigUInt64LE(64);
}

/**
 * Registers a wallet as an approved holder in the investor group, which is what Upside requires
 * before it may hold or receive the security.
 */
async function registerHolder(
  env: Env,
  realRwaMint: PublicKey,
  wallet: Keypair,
  holderId: number
) {
  env.sendOk(
    [
      upside.ix.createAta(
        env.issuer.publicKey,
        realRwaMint,
        wallet.publicKey
      ),
      await upside.ix.initHolder(realRwaMint, env.issuer.publicKey, holderId),
      await upside.ix.initHolderGroup(
        realRwaMint,
        env.issuer.publicKey,
        holderId,
        LAYOUT.investorGroup
      ),
      await upside.ix.initSaa(
        realRwaMint,
        env.issuer.publicKey,
        wallet.publicKey,
        LAYOUT.investorGroup,
        holderId
      ),
    ],
    [env.issuer]
  );
}

/** A fully graduated launch with the bridge open. */
async function graduatedLaunch(env: Env) {
  const quote = await env.makeSplMint(6);
  env.sendOk([await env.whitelistQuoteTokenIx(quote.publicKey)], [env.admin]);

  const mint = await env.fundedLaunch();

  // Holder 0 is the issuer, who must be registered to receive their unsold stock back.
  await registerHolder(env, mint.publicKey, env.issuer, 1);

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

  // Buy out the curve so the sale completes.
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
        TARGET_RAISE * 4n,
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
  expectSuccess(
    env.send(
      [
        Env.computeBudget(),
        swapWithTransferHookIx({
          config: meteoraConfig.publicKey,
          pool,
          inputTokenAccount: buyerQuote,
          outputTokenAccount: buyerCrwa,
          baseVault: Env.meteoraTokenVault(crwaMint.publicKey, pool),
          quoteVault: Env.meteoraTokenVault(quote.publicKey, pool),
          baseMint: crwaMint.publicKey,
          quoteMint: quote.publicKey,
          payer: buyer.publicKey,
          tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
          tokenQuoteProgram: TOKEN_PROGRAM_ID,
          poolAuthority: Env.meteoraPoolAuthority(),
          eventAuthority: Env.meteoraEventAuthority(),
          hookProgram: env.aegisHookProgramId(),
          extraAccountMetaList: Env.extraAccountMetaList(crwaMint.publicKey),
          amountIn: TARGET_RAISE * 2n,
          swapMode: SWAP_MODE.PartialFill,
        }),
      ],
      [buyer]
    )
  );

  // migrate, then settle
  const f = Keypair.generate();
  const s = Keypair.generate();
  expectSuccess(
    env.send(
      [
        Env.computeBudget(),
        migrateDammV2Ix({
          virtualPool: pool,
          config: meteoraConfig.publicKey,
          dbcPoolAuthority: Env.meteoraPoolAuthority(),
          dammPool: dammV2.pool(
            DAMM_V2_DYNAMIC_CONFIG,
            crwaMint.publicKey,
            quote.publicKey
          ),
          firstPositionNftMint: f.publicKey,
          secondPositionNftMint: s.publicKey,
          baseMint: crwaMint.publicKey,
          quoteMint: quote.publicKey,
          dbcBaseVault: Env.meteoraTokenVault(crwaMint.publicKey, pool),
          dbcQuoteVault: Env.meteoraTokenVault(quote.publicKey, pool),
          payer: env.admin.publicKey,
          tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
          tokenQuoteProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        }),
      ],
      [env.admin, f, s]
    )
  );

  expectSuccess(
    env.send(
      [
        Env.computeBudget(),
        await env.finalizeGraduationIx({
          cranker: env.admin.publicKey,
          realRwaMint: mint.publicKey,
          crwaMint: crwaMint.publicKey,
          quoteMint: quote.publicKey,
          meteoraConfig: meteoraConfig.publicKey,
        }),
      ],
      [env.admin]
    )
  );

  return { mint, crwaMint, quote, buyer, buyerCrwa, meteoraConfig, pool };
}

type Launch = Awaited<ReturnType<typeof graduatedLaunch>>;

/** Asserts the invariant the entire protocol rests on. */
function assertPeg(env: Env, l: Launch) {
  const supply = readMint(env, l.crwaMint.publicKey).supply;
  const vault = balance(
    env,
    upside.ataFor(l.mint.publicKey, Env.aegisAuthorityPda(l.mint.publicKey))
  );
  assert.equal(
    vault.toString(),
    supply.toString(),
    "escrowed asset must equal wrapper supply"
  );
  const rec = env.launch(l.mint.publicKey);
  assert.equal(rec.realRwaLocked.toString(), vault.toString());
  assert.equal(rec.crwaMinted.toString(), supply.toString());
}

describe("bridge", () => {
  describe("redeeming", () => {
    let env: Env;
    let l: Launch;

    before(async () => {
      env = await Env.booted();
      l = await graduatedLaunch(env);
      // The buyer holds cRWA from the sale. To take delivery of the security they must be a
      // registered holder like anyone else.
      await registerHolder(env, l.mint.publicKey, env.outsider, 2);
    });

    it("gives back exactly one asset per wrapper burned", async () => {
      const userReal = upside.ataFor(l.mint.publicKey, env.outsider.publicKey);
      const crwaBefore = balance(env, l.buyerCrwa);
      const realBefore = balance(env, userReal);
      const amount = crwaBefore / 4n;
      assert.isTrue(amount > 0n, "buyer should hold wrapper to redeem");

      expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            await env.bridgeRedeemIx({
              user: env.outsider.publicKey,
              realRwaMint: l.mint.publicKey,
              crwaMint: l.crwaMint.publicKey,
              amount,
            }),
          ],
          [env.outsider]
        )
      );

      assert.equal(crwaBefore - balance(env, l.buyerCrwa), amount);
      assert.equal(balance(env, userReal) - realBefore, amount);
    });

    it("destroys the wrapper rather than storing it", () => {
      // Supply must fall. If Aegis merely held the redeemed wrapper it could be resold, and the
      // backing figure would overstate what is actually claimable.
      const aegisCrwa = upside.ataFor(
        l.crwaMint.publicKey,
        Env.aegisAuthorityPda(l.mint.publicKey)
      );
      assert.equal(balance(env, aegisCrwa), 0n);
    });

    it("keeps the peg exact", () => {
      assertPeg(env, l);
    });

    it("refuses more than the holder owns", async () => {
      expectFailure(
        env.send(
          [
            Env.computeBudget(),
            await env.bridgeRedeemIx({
              user: env.outsider.publicKey,
              realRwaMint: l.mint.publicKey,
              crwaMint: l.crwaMint.publicKey,
              amount: balance(env, l.buyerCrwa) + 1n,
            }),
          ],
          [env.outsider]
        )
      );
    });

    it("refuses zero", async () => {
      expectAnchorError(
        env.send(
          [
            Env.computeBudget(),
            await env.bridgeRedeemIx({
              user: env.outsider.publicKey,
              realRwaMint: l.mint.publicKey,
              crwaMint: l.crwaMint.publicKey,
              amount: 0,
            }),
          ],
          [env.outsider]
        ),
        "ZeroBridgeAmount"
      );
    });
  });

  // The whole compliance story in one place. cRWA trades freely and anyone can end up holding
  // it; this is where that stops meaning they can take the security.
  describe("redeeming without approval", () => {
    let env: Env;
    let l: Launch;
    let stranger: Keypair;

    before(async () => {
      env = await Env.booted();
      l = await graduatedLaunch(env);

      // Somebody buys wrapper on the open market with no KYC anywhere in sight.
      stranger = Keypair.generate();
      env.svm.airdrop(stranger.publicKey, 10n * 1_000_000_000n);
      await registerHolder(env, l.mint.publicKey, env.outsider, 2);

      const strangerCrwa = getAssociatedTokenAddressSync(
        l.crwaMint.publicKey,
        stranger.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );
      env.sendOk(
        [
          createAssociatedTokenAccountInstruction(
            stranger.publicKey,
            strangerCrwa,
            stranger.publicKey,
            l.crwaMint.publicKey,
            TOKEN_2022_PROGRAM_ID
          ),
        ],
        [stranger]
      );
      // The wrapper carries no hook after graduation, so this transfer needs no permission at
      // all — which is exactly the point.
      const { createTransferCheckedInstruction } = require("@solana/spl-token");
      env.sendOk(
        [
          createTransferCheckedInstruction(
            l.buyerCrwa,
            l.crwaMint.publicKey,
            strangerCrwa,
            env.outsider.publicKey,
            1_000_000n,
            6,
            [],
            TOKEN_2022_PROGRAM_ID
          ),
        ],
        [env.outsider]
      );
      assert.isTrue(balance(env, strangerCrwa) > 0n);
    });

    it("lets an unapproved wallet hold the wrapper freely", () => {
      const strangerCrwa = upside.ataFor(
        l.crwaMint.publicKey,
        stranger.publicKey
      );
      assert.isTrue(balance(env, strangerCrwa) > 0n);
    });

    it("refuses to hand them the security", async () => {
      // They never registered, so there is no holder record — and no account at that address to
      // load. The redemption simply cannot be constructed.
      expectFailure(
        env.send(
          [
            Env.computeBudget(),
            await env.bridgeRedeemIx({
              user: stranger.publicKey,
              realRwaMint: l.mint.publicKey,
              crwaMint: l.crwaMint.publicKey,
              amount: 100_000n,
            }),
          ],
          [stranger]
        )
      );
    });

    it("lets them through once the issuer approves them", async () => {
      await registerHolder(env, l.mint.publicKey, stranger, 3);

      const userReal = upside.ataFor(l.mint.publicKey, stranger.publicKey);
      const before = balance(env, userReal);
      expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            await env.bridgeRedeemIx({
              user: stranger.publicKey,
              realRwaMint: l.mint.publicKey,
              crwaMint: l.crwaMint.publicKey,
              amount: 100_000n,
            }),
          ],
          [stranger]
        )
      );
      assert.equal(balance(env, userReal) - before, 100_000n);
      assertPeg(env, l);
    });
  });

  describe("depositing", () => {
    let env: Env;
    let l: Launch;

    before(async () => {
      env = await Env.booted();
      l = await graduatedLaunch(env);
      await registerHolder(env, l.mint.publicKey, env.outsider, 2);
      // Redeem first, so the holder has some of the asset to deposit back.
      expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            await env.bridgeRedeemIx({
              user: env.outsider.publicKey,
              realRwaMint: l.mint.publicKey,
              crwaMint: l.crwaMint.publicKey,
              amount: balance(env, l.buyerCrwa) / 2n,
            }),
          ],
          [env.outsider]
        )
      );
    });

    it("gives one wrapper per asset deposited", async () => {
      const userReal = upside.ataFor(l.mint.publicKey, env.outsider.publicKey);
      const realBefore = balance(env, userReal);
      const crwaBefore = balance(env, l.buyerCrwa);
      const amount = realBefore / 2n;
      assert.isTrue(amount > 0n);

      expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            await env.bridgeDepositIx({
              user: env.outsider.publicKey,
              realRwaMint: l.mint.publicKey,
              crwaMint: l.crwaMint.publicKey,
              amount,
            }),
          ],
          [env.outsider]
        )
      );

      assert.equal(realBefore - balance(env, userReal), amount);
      assert.equal(balance(env, l.buyerCrwa) - crwaBefore, amount);
    });

    it("keeps the peg exact", () => {
      assertPeg(env, l);
    });

    it("refuses zero", async () => {
      expectAnchorError(
        env.send(
          [
            Env.computeBudget(),
            await env.bridgeDepositIx({
              user: env.outsider.publicKey,
              realRwaMint: l.mint.publicKey,
              crwaMint: l.crwaMint.publicKey,
              amount: 0,
            }),
          ],
          [env.outsider]
        ),
        "ZeroBridgeAmount"
      );
    });

    it("refuses more than the holder owns", async () => {
      const userReal = upside.ataFor(l.mint.publicKey, env.outsider.publicKey);
      expectFailure(
        env.send(
          [
            Env.computeBudget(),
            await env.bridgeDepositIx({
              user: env.outsider.publicKey,
              realRwaMint: l.mint.publicKey,
              crwaMint: l.crwaMint.publicKey,
              amount: balance(env, userReal) + 1n,
            }),
          ],
          [env.outsider]
        )
      );
    });
  });

  describe("round trips", () => {
    it("returns the holder to exactly where they started", async () => {
      const env = await Env.booted();
      const l = await graduatedLaunch(env);
      await registerHolder(env, l.mint.publicKey, env.outsider, 2);

      const userReal = upside.ataFor(l.mint.publicKey, env.outsider.publicKey);
      const crwaStart = balance(env, l.buyerCrwa);
      const realStart = balance(env, userReal);
      const amount = crwaStart / 3n;

      for (let i = 0; i < 3; i++) {
        expectSuccess(
          env.send(
            [
              Env.computeBudget(),
              await env.bridgeRedeemIx({
                user: env.outsider.publicKey,
                realRwaMint: l.mint.publicKey,
                crwaMint: l.crwaMint.publicKey,
                amount,
              }),
            ],
            [env.outsider]
          )
        );
        assertPeg(env, l);

        expectSuccess(
          env.send(
            [
              Env.computeBudget(),
              await env.bridgeDepositIx({
                user: env.outsider.publicKey,
                realRwaMint: l.mint.publicKey,
                crwaMint: l.crwaMint.publicKey,
                amount,
              }),
            ],
            [env.outsider]
          )
        );
        assertPeg(env, l);
      }

      // One for one in both directions means no rounding, no fee, no drift.
      assert.equal(balance(env, l.buyerCrwa).toString(), crwaStart.toString());
      assert.equal(balance(env, userReal).toString(), realStart.toString());
    });
  });

  describe("when the issuer interferes", () => {
    let env: Env;
    let l: Launch;

    beforeEach(async () => {
      env = await Env.booted();
      l = await graduatedLaunch(env);
      await registerHolder(env, l.mint.publicKey, env.outsider, 2);
    });

    const redeem = async () =>
      env.send(
        [
          Env.computeBudget(),
          await env.bridgeRedeemIx({
            user: env.outsider.publicKey,
            realRwaMint: l.mint.publicKey,
            crwaMint: l.crwaMint.publicKey,
            amount: 100_000n,
          }),
        ],
        [env.outsider]
      );

    it("refuses to redeem while transfers are paused", async () => {
      env.sendOk(
        [await upside.ix.pause(l.mint.publicKey, env.issuer.publicKey, true)],
        [env.issuer]
      );
      expectAnchorError(await redeem(), "TransfersPaused");
    });

    it("refuses to redeem once the redemption rule is closed", async () => {
      env.sendOk(
        [
          await upside.ix.setRule(
            l.mint.publicKey,
            env.issuer.publicKey,
            LAYOUT.vaultGroup,
            LAYOUT.investorGroup,
            0
          ),
        ],
        [env.issuer]
      );
      expectAnchorError(await redeem(), "RedemptionPathClosed");
    });

    it("refuses to deposit into a launch that can no longer be redeemed", async () => {
      // Depositing would mean giving up a real security for a wrapper that can never be
      // unwrapped, so the redemption path is checked on the way in as well as on the way out.
      env.sendOk(
        [
          await upside.ix.setRule(
            l.mint.publicKey,
            env.issuer.publicKey,
            LAYOUT.vaultGroup,
            LAYOUT.investorGroup,
            0
          ),
        ],
        [env.issuer]
      );
      expectAnchorError(
        env.send(
          [
            Env.computeBudget(),
            await env.bridgeDepositIx({
              user: env.outsider.publicKey,
              realRwaMint: l.mint.publicKey,
              crwaMint: l.crwaMint.publicKey,
              amount: 1_000n,
            }),
          ],
          [env.outsider]
        ),
        "RedemptionPathClosed"
      );
    });
  });

  describe("before graduation", () => {
    it("refuses while the sale is still running", async () => {
      const env = await Env.booted();
      const quote = await env.makeSplMint(6);
      env.sendOk([await env.whitelistQuoteTokenIx(quote.publicKey)], [env.admin]);
      const mint = await env.fundedLaunch();
      const cfg = Keypair.generate();
      env.sendOk(
        [
          await env.createRwaConfigIx({
            issuer: env.issuer.publicKey,
            realRwaMint: mint.publicKey,
            quoteMint: quote.publicKey,
            meteoraConfig: cfg.publicKey,
            args: defaultConfigArgs({ targetRaise: TARGET_RAISE }),
          }),
        ],
        [env.issuer, cfg]
      );
      const crwaMint = Keypair.generate();
      env.sendOk(
        [
          Env.computeBudget(),
          await env.launchPoolIx({
            issuer: env.issuer.publicKey,
            realRwaMint: mint.publicKey,
            quoteMint: quote.publicKey,
            meteoraConfig: cfg.publicKey,
            crwaMint: crwaMint.publicKey,
          }),
        ],
        [env.issuer, crwaMint]
      );
      await registerHolder(env, mint.publicKey, env.outsider, 1);

      expectAnchorError(
        env.send(
          [
            Env.computeBudget(),
            await env.bridgeDepositIx({
              user: env.outsider.publicKey,
              realRwaMint: mint.publicKey,
              crwaMint: crwaMint.publicKey,
              amount: 1_000n,
            }),
          ],
          [env.outsider]
        ),
        "InvalidLaunchStage"
      );
    });
  });
});
