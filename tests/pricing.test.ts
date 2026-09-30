/**
 * Launches at any price, not just one USDC.
 *
 * The issuer chooses the opening price (`sqrt_start_price`) and how far it may rise
 * (`sqrt_expansion_bps`, capped by the archetype). Every other end-to-end test opens at exactly
 * 1 USDC per token, so this file runs complete launches — sale, migration, graduation — at very
 * different prices, and with a token whose decimals differ from the quote token's.
 *
 * For each one it checks that the first buyer pays the chosen price, and that the graduated pool
 * opens at exactly start × rise², with no jump at migration.
 */
import { assert } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ARCHETYPE,
  Env,
  defaultConfigArgs,
  defaultRwaArgs,
  expectAnchorError,
  expectSuccess,
} from "./helpers";
import {
  DAMM_V2_DYNAMIC_CONFIG,
  SWAP_MODE,
  dammV2,
  migrateDammV2Ix,
  swapWithTransferHookIx,
} from "./meteora";

const QUOTE_DECIMALS = 6;
const RAISE = 10_000n * 10n ** 6n; // 10,000 USDC

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}

/**
 * A human price — `num / den` USDC per whole token — as Meteora's Q64.64 square-root price.
 *
 * On-chain the price is quote atoms per base atom, so the two tokens' decimals are part of the
 * conversion. Getting this wrong is off by a factor of ten per decimal of difference; the frontend
 * must do exactly this.
 */
function sqrtPriceOf(num: bigint, den: bigint, tokenDecimals: number): bigint {
  const q = 10n ** BigInt(QUOTE_DECIMALS);
  const t = 10n ** BigInt(tokenDecimals);
  return isqrt(((num * q) << 128n) / (den * t));
}

function balance(env: Env, account: PublicKey): bigint {
  const acc = env.svm.getAccount(account);
  return acc ? Buffer.from(acc.data).readBigUInt64LE(64) : 0n;
}

const whole = (atoms: bigint, decimals: number) => Number(atoms) / 10 ** decimals;

type Case = {
  label: string;
  price: [bigint, bigint]; // USDC per token, as a fraction
  decimals: number;
  supply: bigint; // whole tokens
  expansionBps: number;
  archetype: any;
};

const LAUNCHES: Case[] = [
  { label: "$0.05 per token", price: [5n, 100n], decimals: 6, supply: 600_000n, expansionBps: 11_000, archetype: ARCHETYPE.bookBuilding },
  { label: "$25 per token", price: [25n, 1n], decimals: 6, supply: 1_500n, expansionBps: 11_000, archetype: ARCHETYPE.bookBuilding },
  { label: "$1,000 per token", price: [1000n, 1n], decimals: 6, supply: 40n, expansionBps: 11_000, archetype: ARCHETYPE.bookBuilding },
  { label: "$50 per token, 9 decimals against 6", price: [50n, 1n], decimals: 9, supply: 1_000n, expansionBps: 11_000, archetype: ARCHETYPE.bookBuilding },
  { label: "$10, nearly flat (Fixed Par, ~1.02x)", price: [10n, 1n], decimals: 6, supply: 5_000n, expansionBps: 10_099, archetype: ARCHETYPE.fixedPar },
  { label: "$10, widest rise (Growth Capital, ~1.5x)", price: [10n, 1n], decimals: 6, supply: 5_000n, expansionBps: 12_247, archetype: ARCHETYPE.growthCapital },
];

/** A funded launch with an approved quote token, and the config call ready to send. */
async function prepare(env: Env, c: Case) {
  const quote = await env.makeSplMint(QUOTE_DECIMALS);
  env.sendOk([await env.whitelistQuoteTokenIx(quote.publicKey)], [env.admin]);
  const mint = await env.fundedLaunch(
    defaultRwaArgs({
      decimals: c.decimals,
      totalSupply: c.supply * 10n ** BigInt(c.decimals),
    })
  );
  const cfg = Keypair.generate();
  const configure = async () =>
    env.send(
      [
        await env.createRwaConfigIx({
          issuer: env.issuer.publicKey,
          realRwaMint: mint.publicKey,
          quoteMint: quote.publicKey,
          meteoraConfig: cfg.publicKey,
          args: defaultConfigArgs({
            targetRaise: RAISE,
            sqrtStartPrice: sqrtPriceOf(c.price[0], c.price[1], c.decimals),
            sqrtExpansionBps: c.expansionBps,
            archetype: c.archetype,
          }),
        }),
      ],
      [env.issuer, cfg]
    );
  return { quote, mint, cfg, configure };
}

describe("launch pricing", () => {
  for (const c of LAUNCHES) {
    describe(c.label, () => {
      const start = Number(c.price[0]) / Number(c.price[1]);
      const rise = (c.expansionBps / 10_000) ** 2;
      let firstPrice: number;
      let poolPrice: number;
      let env: Env;
      let mint: PublicKey;

      before(async () => {
        env = await Env.booted();
        const p = await prepare(env, c);
        mint = p.mint.publicKey;
        expectSuccess(await p.configure());

        const crwa = Keypair.generate();
        env.sendOk(
          [
            Env.computeBudget(),
            await env.launchPoolIx({
              issuer: env.issuer.publicKey,
              realRwaMint: mint,
              quoteMint: p.quote.publicKey,
              meteoraConfig: p.cfg.publicKey,
              crwaMint: crwa.publicKey,
            }),
          ],
          [env.issuer, crwa]
        );

        const buyer = env.outsider;
        const buyerQuote = getAssociatedTokenAddressSync(p.quote.publicKey, buyer.publicKey, false, TOKEN_PROGRAM_ID);
        const buyerCrwa = getAssociatedTokenAddressSync(crwa.publicKey, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);
        env.sendOk(
          [
            createAssociatedTokenAccountInstruction(env.admin.publicKey, buyerQuote, buyer.publicKey, p.quote.publicKey, TOKEN_PROGRAM_ID),
            createMintToInstruction(p.quote.publicKey, buyerQuote, env.admin.publicKey, RAISE * 4n, [], TOKEN_PROGRAM_ID),
            createAssociatedTokenAccountInstruction(env.admin.publicKey, buyerCrwa, buyer.publicKey, crwa.publicKey, TOKEN_2022_PROGRAM_ID),
          ],
          [env.admin]
        );

        const pool = Env.meteoraPool(p.cfg.publicKey, crwa.publicKey, p.quote.publicKey);
        const buy = (amountIn: bigint, swapMode: number) =>
          env.sendOk(
            [
              Env.computeBudget(),
              swapWithTransferHookIx({
                config: p.cfg.publicKey,
                pool,
                inputTokenAccount: buyerQuote,
                outputTokenAccount: buyerCrwa,
                baseVault: Env.meteoraTokenVault(crwa.publicKey, pool),
                quoteVault: Env.meteoraTokenVault(p.quote.publicKey, pool),
                baseMint: crwa.publicKey,
                quoteMint: p.quote.publicKey,
                payer: buyer.publicKey,
                tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
                tokenQuoteProgram: TOKEN_PROGRAM_ID,
                poolAuthority: Env.meteoraPoolAuthority(),
                eventAuthority: Env.meteoraEventAuthority(),
                hookProgram: env.aegisHookProgramId(),
                extraAccountMetaList: Env.extraAccountMetaList(crwa.publicKey),
                amountIn,
                swapMode,
              }),
            ],
            [buyer]
          );

        // A first buy of 10 USDC. After the 1% fee, 9.90 USDC buys tokens at the opening price.
        buy(10n * 10n ** 6n, SWAP_MODE.ExactIn);
        firstPrice = 9.9 / whole(balance(env, buyerCrwa), c.decimals);

        // Buy out the rest of the curve, migrate, and graduate.
        buy(RAISE * 2n, SWAP_MODE.PartialFill);
        const damm = dammV2.pool(DAMM_V2_DYNAMIC_CONFIG, crwa.publicKey, p.quote.publicKey);
        const first = Keypair.generate();
        const second = Keypair.generate();
        env.sendOk(
          [
            Env.computeBudget(),
            migrateDammV2Ix({
              virtualPool: pool,
              config: p.cfg.publicKey,
              dbcPoolAuthority: Env.meteoraPoolAuthority(),
              dammPool: damm,
              firstPositionNftMint: first.publicKey,
              secondPositionNftMint: second.publicKey,
              baseMint: crwa.publicKey,
              quoteMint: p.quote.publicKey,
              dbcBaseVault: Env.meteoraTokenVault(crwa.publicKey, pool),
              dbcQuoteVault: Env.meteoraTokenVault(p.quote.publicKey, pool),
              payer: env.admin.publicKey,
              tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
              tokenQuoteProgram: TOKEN_PROGRAM_ID,
              token2022Program: TOKEN_2022_PROGRAM_ID,
            }),
          ],
          [env.admin, first, second]
        );
        env.sendOk(
          [
            Env.computeBudget(),
            await env.finalizeGraduationIx({
              cranker: env.admin.publicKey,
              realRwaMint: mint,
              crwaMint: crwa.publicKey,
              quoteMint: p.quote.publicKey,
              meteoraConfig: p.cfg.publicKey,
            }),
          ],
          [env.admin]
        );

        poolPrice =
          whole(balance(env, dammV2.tokenVault(p.quote.publicKey, damm)), QUOTE_DECIMALS) /
          whole(balance(env, dammV2.tokenVault(crwa.publicKey, damm)), c.decimals);
      });

      it("the first buyer pays the chosen opening price", () => {
        assert.approximately(firstPrice / start, 1, 0.01);
      });

      it("the graduated pool opens at exactly start x rise, with no jump", () => {
        assert.approximately(poolPrice / start, rise, 0.01);
      });

      it("graduates", () => {
        assert.deepEqual(env.launch(mint).stage, { graduated: {} });
      });
    });
  }

  // A low price needs a large supply: 10,000 USDC at $0.001 needs about ten million tokens. The
  // launch is refused up front, with a clear error, instead of failing inside Meteora.
  it("refuses a price the supply cannot cover", async () => {
    const env = await Env.booted();
    const { configure } = await prepare(env, {
      label: "",
      price: [1n, 1000n],
      decimals: 6,
      supply: 1_000_000n,
      expansionBps: 11_000,
      archetype: ARCHETYPE.bookBuilding,
    });
    expectAnchorError(await configure(), "SupplyTooSmallForCurve");
  });
});
