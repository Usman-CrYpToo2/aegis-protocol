/**
 * Trading a launched cRWA pool on Meteora.
 *
 * Everything before this proves the pool was *created* correctly. None of it proves the pool can
 * actually be traded, and a hooked Token-2022 mint has a specific way of being silently broken:
 * if the hook's companion account is missing, or the hook accounts are not appended to the swap,
 * the pool looks entirely healthy and every trade reverts.
 *
 * So these tests buy and sell for real, against the Meteora binary dumped from mainnet, and
 * check the peg still holds afterwards.
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
  expectFailure,
  expectSuccess,
} from "./helpers";
import { swapWithTransferHookIx } from "./meteora";
import * as upside from "./upside";

const QUOTE_FUNDING = 50_000_000_000n; // 50,000 of a 6-decimal quote token

/** A live pool plus a buyer holding quote tokens and an empty cRWA account. */
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
        args: defaultConfigArgs(),
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
        QUOTE_FUNDING,
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

function balance(env: Env, tokenAccount: PublicKey, program: PublicKey): bigint {
  const acc = env.svm.getAccount(tokenAccount);
  if (!acc) return 0n;
  return unpackAccount(
    tokenAccount,
    { ...acc, data: Buffer.from(acc.data) } as any,
    program
  ).amount;
}

describe("trading a launched pool", () => {
  describe("buying", () => {
    let env: Env;
    let m: Awaited<ReturnType<typeof liveMarket>>;

    before(async () => {
      env = await Env.booted();
      m = await liveMarket(env);
    });

    const buy = (amountIn: bigint, omitHookAccounts = false) =>
      env.send(
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
            omitHookAccounts,
          }),
        ],
        [m.buyer]
      );

    // The test that actually matters: a launched pool can be traded.
    it("lets a buyer swap quote for cRWA", () => {
      const spend = 1_000_000_000n; // 1,000 quote tokens
      const quoteBefore = balance(env, m.buyerQuote, TOKEN_PROGRAM_ID);
      const crwaBefore = balance(env, m.buyerCrwa, TOKEN_2022_PROGRAM_ID);

      expectSuccess(buy(spend));

      const quoteAfter = balance(env, m.buyerQuote, TOKEN_PROGRAM_ID);
      const crwaAfter = balance(env, m.buyerCrwa, TOKEN_2022_PROGRAM_ID);

      assert.equal(quoteBefore - quoteAfter, spend, "the buyer spent what they asked to");
      assert.isTrue(crwaAfter > crwaBefore, "the buyer received cRWA");
    });

    it("moves the tokens through Meteora's vaults", () => {
      const spend = 500_000_000n;
      const baseBefore = balance(env, m.baseVault, TOKEN_2022_PROGRAM_ID);
      const quoteVaultBefore = balance(env, m.quoteVault, TOKEN_PROGRAM_ID);

      expectSuccess(buy(spend));

      assert.isTrue(
        balance(env, m.baseVault, TOKEN_2022_PROGRAM_ID) < baseBefore,
        "cRWA left the pool"
      );
      assert.equal(
        balance(env, m.quoteVault, TOKEN_PROGRAM_ID) - quoteVaultBefore,
        spend,
        "quote arrived in the pool"
      );
    });

    // Confirms the hook is genuinely in the transfer path rather than merely attached to the
    // mint. If this passed without the hook accounts, the earlier setup would be decorative.
    it("fails when the hook accounts are not supplied", () => {
      expectFailure(buy(1_000_000n, true));
    });

    it("keeps the peg untouched while trading", () => {
      // Trading moves cRWA between the pool and buyers. It never creates or destroys any, so
      // the escrowed asset still matches total supply exactly.
      const launch = env.launch(m.mint.publicKey);
      const crwaAcc = env.svm.getAccount(m.crwaMint.publicKey)!;
      const supply = unpackMint(
        m.crwaMint.publicKey,
        { ...crwaAcc, data: Buffer.from(crwaAcc.data) } as any,
        TOKEN_2022_PROGRAM_ID
      ).supply;

      const vault = upside.ataFor(
        m.mint.publicKey,
        Env.aegisAuthorityPda(m.mint.publicKey)
      );
      assert.equal(
        supply.toString(),
        balance(env, vault, TOKEN_2022_PROGRAM_ID).toString()
      );
      assert.equal(
        launch.crwaMinted.toString(),
        launch.realRwaLocked.toString()
      );
    });

    it("prices later buys above earlier ones", () => {
      // The curve rises, so the same spend must buy strictly fewer tokens the second time.
      const spend = 1_000_000_000n;

      const before1 = balance(env, m.buyerCrwa, TOKEN_2022_PROGRAM_ID);
      expectSuccess(buy(spend));
      const got1 = balance(env, m.buyerCrwa, TOKEN_2022_PROGRAM_ID) - before1;

      const before2 = balance(env, m.buyerCrwa, TOKEN_2022_PROGRAM_ID);
      expectSuccess(buy(spend));
      const got2 = balance(env, m.buyerCrwa, TOKEN_2022_PROGRAM_ID) - before2;

      assert.isTrue(got2 < got1, `expected a rising price, got ${got1} then ${got2}`);
    });
  });

  describe("selling", () => {
    let env: Env;
    let m: Awaited<ReturnType<typeof liveMarket>>;

    before(async () => {
      env = await Env.booted();
      m = await liveMarket(env);
      // buy first, so there is something to sell
      expectSuccess(
        env.send(
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
              extraAccountMetaList: Env.extraAccountMetaList(
                m.crwaMint.publicKey
              ),
              amountIn: 2_000_000_000n,
            }),
          ],
          [m.buyer]
        )
      );
    });

    // A curve that only lets people in is a trap. Selling has to work too.
    it("lets a holder swap cRWA back for quote", () => {
      const crwaBefore = balance(env, m.buyerCrwa, TOKEN_2022_PROGRAM_ID);
      const quoteBefore = balance(env, m.buyerQuote, TOKEN_PROGRAM_ID);
      assert.isTrue(crwaBefore > 0n, "buyer should be holding cRWA");

      const sell = crwaBefore / 2n;
      expectSuccess(
        env.send(
          [
            Env.computeBudget(),
            swapWithTransferHookIx({
              config: m.meteoraConfig.publicKey,
              pool: m.pool,
              // direction is inferred from which account is the input
              inputTokenAccount: m.buyerCrwa,
              outputTokenAccount: m.buyerQuote,
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
              extraAccountMetaList: Env.extraAccountMetaList(
                m.crwaMint.publicKey
              ),
              amountIn: sell,
            }),
          ],
          [m.buyer]
        )
      );

      assert.equal(
        crwaBefore - balance(env, m.buyerCrwa, TOKEN_2022_PROGRAM_ID),
        sell,
        "the holder sold what they asked to"
      );
      assert.isTrue(
        balance(env, m.buyerQuote, TOKEN_PROGRAM_ID) > quoteBefore,
        "the holder received quote back"
      );
    });
  });

  describe("the hook", () => {
    it("is attached to cRWA and approves transfers", async () => {
      const env = await Env.booted();
      const m = await liveMarket(env);

      const acc = env.svm.getAccount(m.crwaMint.publicKey)!;
      const hook = getTransferHook(
        unpackMint(
          m.crwaMint.publicKey,
          { ...acc, data: Buffer.from(acc.data) } as any,
          TOKEN_2022_PROGRAM_ID
        )
      );
      assert.equal(
        hook!.programId.toBase58(),
        env.aegisHookProgramId().toBase58()
      );
      // The hook authority is Meteora's pool authority, not ours and not the issuer's — which
      // is what lets Meteora strip the hook at graduation so the pool can move to the AMM.
      assert.equal(
        hook!.authority?.toBase58(),
        Env.meteoraPoolAuthority().toBase58()
      );
    });
  });
});
