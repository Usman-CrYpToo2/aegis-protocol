import { assert } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction, createMintToInstruction,
  getAssociatedTokenAddressSync, unpackMint,
} from "@solana/spl-token";
import { Env, defaultConfigArgs, expectSuccess } from "./helpers";
import { DAMM_V2_DYNAMIC_CONFIG, SWAP_MODE, dammV2, migrateDammV2Ix, swapWithTransferHookIx } from "./meteora";
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
export async function registerHolder(
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
export async function graduatedLaunch(env: Env) {
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

