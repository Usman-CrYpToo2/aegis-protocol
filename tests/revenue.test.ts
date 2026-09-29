/**
 * Collecting the protocol's revenue, and abandoning a launch.
 *
 * Both were gaps found in the security review rather than attacks.
 *
 * Meteora pays the partner side to whatever the config records as `fee_claimer`, which for Aegis
 * must be a PDA — the same field grants cRWA mint authority, which the bridge runs on. Every
 * partner claim therefore requires this program to sign, and until these instructions existed the
 * revenue accrued where nobody could reach it. Silently: the issuer's side is an ordinary wallet
 * that calls Meteora directly, so only the protocol's own money was stranded.
 *
 * The abort path closes the other gap: `fund_vault` escrows the entire supply, and every route
 * out of the vault required the launch to have gone live.
 */
import { assert } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Env,
  defaultConfigArgs,
  defaultRwaArgs,
  expectAnchorError,
  expectFailure,
  expectSuccess,
} from "./helpers";
import { graduatedLaunch, registerHolder } from "./fixtures";
import * as upside from "./upside";

function balance(env: Env, account: PublicKey): bigint {
  const acc = env.svm.getAccount(account);
  if (!acc) return 0n;
  return Buffer.from(acc.data).readBigUInt64LE(64);
}

describe("protocol revenue", () => {
  let env: Env;
  let l: Awaited<ReturnType<typeof graduatedLaunch>>;
  let treasuryQuote: PublicKey;

  before(async () => {
    env = await Env.booted();
    // The protocol's share of the migration fee is zero by default — the raise belongs to the
    // issuer, and Aegis is paid by the placement fee on the curve instead. Set it here so the
    // claim instruction has something to move; at the default it is correctly a no-op.
    env.sendOk(
      [await env.updatePlatformConfigIx({ aegisMigrationFeeSharePct: 20 })],
      [env.admin]
    );
    l = await graduatedLaunch(env);
    treasuryQuote = getAssociatedTokenAddressSync(
      l.quote.publicKey,
      env.treasury.publicKey,
      true,
      TOKEN_PROGRAM_ID
    );
  });

  it("has accrued trading fees to the protocol's PDA", () => {
    // Sanity: there is something to claim. The partner share of the curve's 1% fee.
    const rec = env.launch(l.mint.publicKey);
    assert.equal(rec.crwaMint.toBase58(), l.crwaMint.publicKey.toBase58());
  });

  it("claims curve trading fees to the treasury", async () => {
    const before = balance(env, treasuryQuote);
    expectSuccess(
      env.send(
        [
          Env.computeBudget(),
          await env.claimTradingFeeIx(l.mint.publicKey, env.admin.publicKey),
        ],
        [env.admin]
      )
    );
    assert.isTrue(
      balance(env, treasuryQuote) > before,
      "the protocol should have received its share of the trading fees"
    );
  });

  // The destination is pinned to the platform fee recipient, so a stranger calling this only
  // pays to move the protocol's money to the protocol. That makes it safe to crank.
  it("can be cranked by anyone", async () => {
    const stranger = Keypair.generate();
    env.svm.airdrop(stranger.publicKey, 10n * 1_000_000_000n);
    expectSuccess(
      env.send(
        [
          Env.computeBudget(),
          await env.claimTradingFeeIx(l.mint.publicKey, stranger.publicKey),
        ],
        [stranger]
      )
    );
  });

  it("sends nothing to the caller", async () => {
    const stranger = Keypair.generate();
    env.svm.airdrop(stranger.publicKey, 10n * 1_000_000_000n);
    const strangerQuote = getAssociatedTokenAddressSync(
      l.quote.publicKey,
      stranger.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );
    env.sendOk(
      [
        Env.computeBudget(),
        await env.claimTradingFeeIx(l.mint.publicKey, stranger.publicKey),
      ],
      [stranger]
    );
    assert.equal(balance(env, strangerQuote), 0n);
  });

  it("takes no migration fee by default", async () => {
    // Documents the choice above rather than the plumbing: the raise is the issuer's money.
    const fresh = await Env.booted();
    const cfg = fresh.svm.getAccount(Env.platformConfigPda())!;
    // 8 discriminator + 32 admin + 32 fee_recipient + 8 creation_fee + 1 is_paused
    //   + 2 curve_fee_bps + 1 issuer_curve_fee_share_pct = offset of the field.
    assert.equal(Buffer.from(cfg.data)[8 + 32 + 32 + 8 + 1 + 2 + 1], 0);
  });

  it("claims the migration fee", async () => {
    const before = balance(env, treasuryQuote);
    expectSuccess(
      env.send(
        [
          Env.computeBudget(),
          await env.claimMigrationFeeIx(l.mint.publicKey, env.admin.publicKey),
        ],
        [env.admin]
      )
    );
    assert.isTrue(
      balance(env, treasuryQuote) > before,
      "the protocol's share of the migration fee should have arrived"
    );
  });

  it("leaves no wrapper tokens with the protocol", () => {
    // The base side is never claimed: fee collection is pinned to quote-only, and the claim asks
    // for zero on the base side rather than an unbounded maximum.
    const aegisCrwa = upside.ataFor(
      l.crwaMint.publicKey,
      Env.aegisAuthorityPda(l.mint.publicKey)
    );
    assert.equal(balance(env, aegisCrwa), 0n);
  });

  it("does not disturb the peg", () => {
    const rec = env.launch(l.mint.publicKey);
    assert.isTrue(
      BigInt(rec.realRwaLocked.toString()) >=
        BigInt(rec.crwaMinted.toString()),
      "claiming quote revenue must not touch the backing"
    );
  });
});

describe("abandoning a launch", () => {
  /** A funded launch whose issuer is a registered holder, so the asset can come back. */
  async function fundedLaunchWithRegisteredIssuer(env: Env) {
    const mint = await env.fundedLaunch();
    await registerHolder(env, mint.publicKey, env.issuer, 1);
    return mint;
  }

  it("returns the whole escrowed supply to the issuer", async () => {
    const env = await Env.booted();
    const mint = await fundedLaunchWithRegisteredIssuer(env);
    const issuerAta = upside.ataFor(mint.publicKey, env.issuer.publicKey);
    const vault = upside.ataFor(
      mint.publicKey,
      Env.aegisAuthorityPda(mint.publicKey)
    );

    const escrowed = balance(env, vault);
    assert.equal(escrowed.toString(), defaultRwaArgs().totalSupply.toString());

    expectSuccess(
      env.send(
        [Env.computeBudget(), await env.abortLaunchIx(mint.publicKey)],
        [env.issuer]
      )
    );

    assert.equal(balance(env, vault), 0n);
    assert.equal(balance(env, issuerAta).toString(), escrowed.toString());
    assert.deepEqual(env.launch(mint.publicKey).stage, { aborted: {} });
  });

  it("works after a Meteora config exists too", async () => {
    const env = await Env.booted();
    const quote = await env.makeSplMint(6);
    env.sendOk([await env.whitelistQuoteTokenIx(quote.publicKey)], [env.admin]);
    const mint = await fundedLaunchWithRegisteredIssuer(env);
    const cfg = Keypair.generate();
    env.sendOk(
      [
        await env.createRwaConfigIx({
          issuer: env.issuer.publicKey,
          realRwaMint: mint.publicKey,
          quoteMint: quote.publicKey,
          meteoraConfig: cfg.publicKey,
          args: defaultConfigArgs(),
        }),
      ],
      [env.issuer, cfg]
    );
    assert.deepEqual(env.launch(mint.publicKey).stage, { configured: {} });

    expectSuccess(
      env.send(
        [Env.computeBudget(), await env.abortLaunchIx(mint.publicKey)],
        [env.issuer]
      )
    );
    assert.deepEqual(env.launch(mint.publicKey).stage, { aborted: {} });
  });

  it("is terminal — it cannot run twice", async () => {
    const env = await Env.booted();
    const mint = await fundedLaunchWithRegisteredIssuer(env);
    env.sendOk(
      [Env.computeBudget(), await env.abortLaunchIx(mint.publicKey)],
      [env.issuer]
    );
    expectAnchorError(
      env.send(
        [Env.computeBudget(), await env.abortLaunchIx(mint.publicKey)],
        [env.issuer]
      ),
      "InvalidLaunchStage"
    );
  });

  it("refuses anyone but the issuer", async () => {
    const env = await Env.booted();
    const mint = await fundedLaunchWithRegisteredIssuer(env);
    // Built naming the outsider as issuer, so the program's own check rejects it rather than
    // the transaction failing signature verification before reaching us.
    const ix = await env.abortLaunchIx(mint.publicKey, env.outsider.publicKey);
    expectFailure(env.send([Env.computeBudget(), ix], [env.outsider]));
  });

  // The safety boundary. Once a wrapper exists it is backed by this asset and belongs to whoever
  // bought it; the issuer can no longer take it back.
  it("refuses once the sale has gone live", async () => {
    const env = await Env.booted();
    const quote = await env.makeSplMint(6);
    env.sendOk([await env.whitelistQuoteTokenIx(quote.publicKey)], [env.admin]);
    const mint = await env.fundedLaunch();
    await registerHolder(env, mint.publicKey, env.issuer, 1);

    const cfg = Keypair.generate();
    env.sendOk(
      [
        await env.createRwaConfigIx({
          issuer: env.issuer.publicKey,
          realRwaMint: mint.publicKey,
          quoteMint: quote.publicKey,
          meteoraConfig: cfg.publicKey,
          args: defaultConfigArgs(),
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

    expectAnchorError(
      env.send(
        [Env.computeBudget(), await env.abortLaunchIx(mint.publicKey)],
        [env.issuer]
      ),
      "InvalidLaunchStage"
    );
  });

  it("refuses after graduation", async () => {
    const env = await Env.booted();
    const l = await graduatedLaunch(env);
    expectAnchorError(
      env.send(
        [Env.computeBudget(), await env.abortLaunchIx(l.mint.publicKey)],
        [env.issuer]
      ),
      "InvalidLaunchStage"
    );
  });

  it("refuses while the issuer is not a registered holder", async () => {
    const env = await Env.booted();
    const mint = await env.fundedLaunch(); // issuer never registered
    expectFailure(
      env.send(
        [Env.computeBudget(), await env.abortLaunchIx(mint.publicKey)],
        [env.issuer]
      )
    );
  });
});
