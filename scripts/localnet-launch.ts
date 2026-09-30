/**
 * Runs one complete Aegis launch against the local node, as real transactions.
 *
 *   ./scripts/localnet.sh            # terminal 1: start the node
 *   ./scripts/localnet-deploy.sh     # terminal 2: deploy Aegis
 *   yarn localnet:launch             #             run a launch
 *
 * The same lifecycle as tests/lifecycle.test.ts, but sent to a real node over RPC. Instructions
 * are built by the test helpers — the code the test suite already proves correct — with account
 * reads served from the node instead of the in-memory test chain.
 *
 * Wallets are throwaway keypairs kept in .localnet/actors.json, so a second run on the same node
 * reuses the same admin and simply starts another launch.
 *
 * Optional, to fill a local registry with launches at different stages:
 *
 *   AEGIS_NAME="Aegis Tower B" AEGIS_SYMBOL=TWRB   the asset's name and symbol
 *   AEGIS_STOP_AT=funded|live|graduated            where to stop (default: graduated, then bridge
 *                                                  and claims, the full lifecycle)
 *   AEGIS_BUY=6200                                 USDC to buy when stopping at live
 *   AEGIS_SKIP_CLAIMS=1                            graduate, but leave the issuer's raise and unsold
 *                                                  stock uncollected (to collect from the app)
 */
import * as fs from "fs";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Env, defaultConfigArgs, defaultRwaArgs } from "../tests/helpers";
import {
  DAMM_V2_DYNAMIC_CONFIG,
  SWAP_MODE,
  dammV2,
  migrateDammV2Ix,
  swapWithTransferHookIx,
} from "../tests/meteora";
import * as upside from "../tests/upside";

const RPC = "http://127.0.0.1:8899";
const ACTORS_FILE = ".localnet/actors.json";
const USDC_DECIMALS = 6;
const TARGET_RAISE = 10_000n * 10n ** 6n; // 10,000 USDC
const LAYOUT = upside.DEFAULT_LAYOUT;
const ISSUER_HOLDER_ID = 1; // the vault is holder 0
const BUYER_HOLDER_ID = 2;

const conn = new Connection(RPC, "confirmed");

const STAGES = ["funded", "live", "graduated"] as const;
type StopAt = (typeof STAGES)[number];

function readOptions() {
  const stopAt = (process.env.AEGIS_STOP_AT ?? "graduated") as StopAt;
  if (!STAGES.includes(stopAt)) throw new Error(`AEGIS_STOP_AT must be one of ${STAGES.join(", ")}`);
  const symbol = process.env.AEGIS_SYMBOL ?? "TWRA";
  if (!/^[A-Z0-9]{1,8}$/.test(symbol)) throw new Error("AEGIS_SYMBOL must be 1-8 capital letters or digits");
  const buyWhole = BigInt(process.env.AEGIS_BUY ?? "6200");
  if (buyWhole <= 0n) throw new Error("AEGIS_BUY must be a positive whole number of USDC");
  return { name: process.env.AEGIS_NAME ?? "Aegis Tower A", symbol, stopAt, buy: buyWhole * 10n ** BigInt(USDC_DECIMALS) };
}

// ------------------------------------------------------------------------------------------------
// The test helpers read accounts synchronously from the in-memory chain. This serves the same
// reads from the node: load the accounts a builder needs, then call it.
// ------------------------------------------------------------------------------------------------
class NodeAccounts {
  private cache = new Map<string, any>();

  async load(...keys: PublicKey[]) {
    const infos = await conn.getMultipleAccountsInfo(keys);
    keys.forEach((k, i) => this.cache.set(k.toBase58(), infos[i]));
  }

  getAccount(key: PublicKey) {
    return this.cache.get(key.toBase58()) ?? null;
  }
}

type Actors = { admin: Keypair; issuer: Keypair; treasury: Keypair; buyer: Keypair; usdc: Keypair };

function loadActors(): Actors {
  const names = ["admin", "issuer", "treasury", "buyer", "usdc"] as const;
  if (!fs.existsSync(ACTORS_FILE)) {
    const fresh = Object.fromEntries(names.map((n) => [n, Array.from(Keypair.generate().secretKey)]));
    fs.writeFileSync(ACTORS_FILE, JSON.stringify(fresh));
  }
  const raw = JSON.parse(fs.readFileSync(ACTORS_FILE, "utf8"));
  return Object.fromEntries(
    names.map((n) => [n, Keypair.fromSecretKey(Uint8Array.from(raw[n]))])
  ) as Actors;
}

const explorer = (sig: string) =>
  `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(RPC)}`;

async function send(label: string, ixs: TransactionInstruction[], signers: Keypair[]) {
  try {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, {
      commitment: "confirmed",
    });
    console.log(`  ✓ ${label.padEnd(46)} ${sig.slice(0, 16)}…`);
    return sig;
  } catch (e) {
    console.error(`  ✗ ${label}`);
    if (e instanceof SendTransactionError) {
      console.error((await e.getLogs(conn))?.join("\n"));
    }
    throw e;
  }
}

async function tokenBalance(account: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(account);
  return info ? Buffer.from(info.data).readBigUInt64LE(64) : 0n;
}

async function mintSupply(mint: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(mint);
  return Buffer.from(info!.data).readBigUInt64LE(36);
}

const whole = (atoms: bigint, decimals = 6) => (Number(atoms) / 10 ** decimals).toLocaleString();

async function main() {
  const version = await conn.getVersion().catch(() => null);
  if (!version) throw new Error(`No local node at ${RPC}. Start it with scripts/localnet.sh.`);

  const { admin, issuer, treasury, buyer, usdc } = loadActors();
  const options = readOptions();

  // The helpers, pointed at the node.
  const env = Env.create();
  const accounts = new NodeAccounts();
  (env as any).svm = accounts;
  env.admin = admin;
  env.issuer = issuer;
  env.treasury = treasury;
  env.outsider = buyer;

  console.log(`\nAegis launch on ${RPC} (solana-core ${version["solana-core"]})\n`);

  // ----------------------------------------------------------------------------------------------
  console.log("Wallets");
  for (const [who, kp, sol] of [
    ["admin", admin, 100],
    ["issuer", issuer, 100],
    ["buyer", buyer, 10],
    ["treasury", treasury, 1],
  ] as const) {
    if ((await conn.getBalance(kp.publicKey)) < LAMPORTS_PER_SOL / 2) {
      const latest = await conn.getLatestBlockhash();
      const signature = await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
      await conn.confirmTransaction({ signature, ...latest }, "confirmed");
    }
    console.log(`  ${who.padEnd(9)} ${kp.publicKey.toBase58()}`);
  }

  // ----------------------------------------------------------------------------------------------
  console.log("\nPlatform (once per node)");
  if (!(await conn.getAccountInfo(Env.platformConfigPda()))) {
    await send("initialize_platform", [await env.initializePlatformIx()], [admin]);
    await send(
      "update_platform_config: treasury",
      [await env.updatePlatformConfigIx({ newFeeRecipient: treasury.publicKey })],
      [admin]
    );
  } else {
    console.log("  · already initialised");
  }

  if (!(await conn.getAccountInfo(usdc.publicKey))) {
    const rent = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);
    await send(
      "create a stand-in USDC mint",
      [
        SystemProgram.createAccount({
          fromPubkey: admin.publicKey,
          newAccountPubkey: usdc.publicKey,
          space: MINT_SIZE,
          lamports: rent,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMintInstruction(usdc.publicKey, USDC_DECIMALS, admin.publicKey, null),
      ],
      [admin, usdc]
    );
    await send("whitelist_quote_token", [await env.whitelistQuoteTokenIx(usdc.publicKey)], [admin]);
  } else {
    console.log("  · USDC already whitelisted");
  }
  labelQuoteForApp(usdc.publicKey);

  // ----------------------------------------------------------------------------------------------
  console.log("\nIssuer prepares the asset");
  const rwa = Keypair.generate();
  const mint = rwa.publicKey;
  const vault = upside.ataFor(mint, Env.aegisAuthorityPda(mint));
  const rwaArgs = defaultRwaArgs({
    name: options.name,
    symbol: options.symbol,
    uri: `https://aegis.test/${options.symbol.toLowerCase()}.json`,
  });

  await send(
    "create_rwa",
    [
      await env.createRwaIx({
        issuer: issuer.publicKey,
        realRwaMint: mint,
        feeRecipient: treasury.publicKey,
        args: rwaArgs,
      }),
    ],
    [issuer, rwa]
  );

  // The issuer's own compliance setup, through Upside — exactly what setupCompliance does in the
  // tests.
  const a = issuer.publicKey;
  const authority = Env.aegisAuthorityPda(mint);
  await send(
    "Upside: rule book + hook accounts",
    [await upside.ix.initRuleBook(mint, a, LAYOUT.maxHolders), await upside.ix.initHookMetas(mint, a)],
    [issuer]
  );
  await send(
    "Upside: groups + vault<->investor rules",
    [
      await upside.ix.initGroup(mint, a, LAYOUT.investorGroup),
      await upside.ix.initGroup(mint, a, LAYOUT.vaultGroup),
      await upside.ix.initRule(mint, a, LAYOUT.vaultGroup, LAYOUT.investorGroup, 1),
      await upside.ix.initRule(mint, a, LAYOUT.investorGroup, LAYOUT.vaultGroup, 1),
    ],
    [issuer]
  );
  await send(
    "Upside: register the vault",
    [
      upside.ix.createAta(a, mint, authority),
      await upside.ix.initHolder(mint, a, LAYOUT.vaultHolderId),
      await upside.ix.initHolderGroup(mint, a, LAYOUT.vaultHolderId, LAYOUT.vaultGroup),
      await upside.ix.initSaa(mint, a, authority, LAYOUT.vaultGroup, LAYOUT.vaultHolderId),
    ],
    [issuer]
  );

  const register = async (label: string, wallet: PublicKey, holderId: number) =>
    send(
      label,
      [
        upside.ix.createAta(a, mint, wallet),
        await upside.ix.initHolder(mint, a, holderId),
        await upside.ix.initHolderGroup(mint, a, holderId, LAYOUT.investorGroup),
        await upside.ix.initSaa(mint, a, wallet, LAYOUT.investorGroup, holderId),
      ],
      [issuer]
    );
  await register("Upside: register the issuer as a holder", issuer.publicKey, ISSUER_HOLDER_ID);

  await send(
    "fund_vault",
    [
      Env.computeBudget(),
      await env.fundVaultIx({
        issuer: issuer.publicKey,
        realRwaMint: mint,
        investorGroup: LAYOUT.investorGroup,
        vaultGroup: LAYOUT.vaultGroup,
      }),
    ],
    [issuer]
  );

  if (options.stopAt === "funded") return summary("funded", mint, usdc.publicKey);

  // ----------------------------------------------------------------------------------------------
  console.log("\nThe sale");
  const config = Keypair.generate();
  await send(
    "create_rwa_config",
    [
      await env.createRwaConfigIx({
        issuer: issuer.publicKey,
        realRwaMint: mint,
        quoteMint: usdc.publicKey,
        meteoraConfig: config.publicKey,
        args: defaultConfigArgs({ targetRaise: TARGET_RAISE }),
      }),
    ],
    [issuer, config]
  );

  const crwa = Keypair.generate();
  await accounts.load(Env.launchPda(mint));
  await send(
    "launch_pool",
    [
      Env.computeBudget(),
      await env.launchPoolIx({
        issuer: issuer.publicKey,
        realRwaMint: mint,
        quoteMint: usdc.publicKey,
        meteoraConfig: config.publicKey,
        crwaMint: crwa.publicKey,
        args: {
          name: `Wrapped ${options.name}`.slice(0, 32),
          symbol: `c${options.symbol}`,
          uri: `https://aegis.test/c${options.symbol.toLowerCase()}.json`,
        },
      }),
    ],
    [issuer, crwa]
  );

  const buyerUsdc = getAssociatedTokenAddressSync(usdc.publicKey, buyer.publicKey, false, TOKEN_PROGRAM_ID);
  const buyerCrwa = getAssociatedTokenAddressSync(crwa.publicKey, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const setup: TransactionInstruction[] = [];
  if (!(await conn.getAccountInfo(buyerUsdc))) {
    setup.push(
      createAssociatedTokenAccountInstruction(admin.publicKey, buyerUsdc, buyer.publicKey, usdc.publicKey, TOKEN_PROGRAM_ID)
    );
  }
  setup.push(
    createMintToInstruction(usdc.publicKey, buyerUsdc, admin.publicKey, TARGET_RAISE * 4n, [], TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountInstruction(admin.publicKey, buyerCrwa, buyer.publicKey, crwa.publicKey, TOKEN_2022_PROGRAM_ID)
  );
  await send("give the buyer USDC", setup, [admin]);

  const pool = Env.meteoraPool(config.publicKey, crwa.publicKey, usdc.publicKey);
  await send(
    "buy out the curve (swap2_with_transfer_hook)",
    [
      Env.computeBudget(),
      swapWithTransferHookIx({
        config: config.publicKey,
        pool,
        inputTokenAccount: buyerUsdc,
        outputTokenAccount: buyerCrwa,
        baseVault: Env.meteoraTokenVault(crwa.publicKey, pool),
        quoteVault: Env.meteoraTokenVault(usdc.publicKey, pool),
        baseMint: crwa.publicKey,
        quoteMint: usdc.publicKey,
        payer: buyer.publicKey,
        tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        poolAuthority: Env.meteoraPoolAuthority(),
        eventAuthority: Env.meteoraEventAuthority(),
        hookProgram: env.aegisHookProgramId(),
        extraAccountMetaList: Env.extraAccountMetaList(crwa.publicKey),
        // Buying twice the target buys the whole curve out; a smaller amount leaves it open.
        amountIn: options.stopAt === "live" ? options.buy : TARGET_RAISE * 2n,
        swapMode: SWAP_MODE.PartialFill,
      }),
    ],
    [buyer]
  );
  console.log(`    buyer received ${whole(await tokenBalance(buyerCrwa))} cRWA`);
  if (options.stopAt === "live") return summary("live", mint, usdc.publicKey);

  // ----------------------------------------------------------------------------------------------
  console.log("\nGraduation");
  const first = Keypair.generate();
  const second = Keypair.generate();
  await send(
    "Meteora: migrate to DAMM v2",
    [
      Env.computeBudget(),
      migrateDammV2Ix({
        virtualPool: pool,
        config: config.publicKey,
        dbcPoolAuthority: Env.meteoraPoolAuthority(),
        dammPool: dammV2.pool(DAMM_V2_DYNAMIC_CONFIG, crwa.publicKey, usdc.publicKey),
        firstPositionNftMint: first.publicKey,
        secondPositionNftMint: second.publicKey,
        baseMint: crwa.publicKey,
        quoteMint: usdc.publicKey,
        dbcBaseVault: Env.meteoraTokenVault(crwa.publicKey, pool),
        dbcQuoteVault: Env.meteoraTokenVault(usdc.publicKey, pool),
        payer: admin.publicKey,
        tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
        tokenQuoteProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      }),
    ],
    [admin, first, second]
  );
  await send(
    "finalize_graduation",
    [
      Env.computeBudget(),
      await env.finalizeGraduationIx({
        cranker: admin.publicKey,
        realRwaMint: mint,
        crwaMint: crwa.publicKey,
        quoteMint: usdc.publicKey,
        meteoraConfig: config.publicKey,
      }),
    ],
    [admin]
  );

  // ----------------------------------------------------------------------------------------------
  console.log("\nThe bridge");
  await register("Upside: register the buyer (KYC)", buyer.publicKey, BUYER_HOLDER_ID);
  const redeemAmount = (await tokenBalance(buyerCrwa)) / 4n;
  await accounts.load(Env.launchPda(mint));
  await send(
    `bridge_redeem ${whole(redeemAmount)} cRWA`,
    [
      Env.computeBudget(),
      await env.bridgeRedeemIx({ user: buyer.publicKey, realRwaMint: mint, crwaMint: crwa.publicKey, amount: redeemAmount }),
    ],
    [buyer]
  );
  const depositAmount = redeemAmount / 2n;
  await send(
    `bridge_deposit ${whole(depositAmount)} RWA`,
    [
      Env.computeBudget(),
      await env.bridgeDepositIx({ user: buyer.publicKey, realRwaMint: mint, crwaMint: crwa.publicKey, amount: depositAmount }),
    ],
    [buyer]
  );

  if (process.env.AEGIS_SKIP_CLAIMS === "1") {
    console.log("\nClaims skipped: the raise and unsold stock are left for the issuer to collect.");
    return summary("graduated", mint, usdc.publicKey);
  }

  // ----------------------------------------------------------------------------------------------
  console.log("\nClaims");
  await accounts.load(Env.launchPda(mint), Env.platformConfigPda());
  await send("claim_unsold (issuer)", [Env.computeBudget(), await env.claimUnsoldIx(mint)], [issuer]);
  await send(
    "claim_partner_trading_fee",
    [Env.computeBudget(), await env.claimTradingFeeIx(mint, admin.publicKey)],
    [admin]
  );
  const lastSig = await send(
    "claim_partner_migration_fee",
    [Env.computeBudget(), await env.claimMigrationFeeIx(mint, admin.publicKey)],
    [admin]
  );

  // ----------------------------------------------------------------------------------------------
  await accounts.load(Env.launchPda(mint));
  const launch = env.launch(mint);
  const escrowed = await tokenBalance(vault);
  const supply = await mintSupply(crwa.publicKey);
  const owed = BigInt(launch.issuerUnsold.toString());
  const treasuryUsdc = getAssociatedTokenAddressSync(usdc.publicKey, treasury.publicKey, true, TOKEN_PROGRAM_ID);

  console.log("\nResult");
  console.log(`  stage .................... ${Object.keys(launch.stage)[0]}`);
  console.log(`  escrowed RWA ............. ${whole(escrowed)}`);
  console.log(`  cRWA in circulation ...... ${whole(supply)}`);
  console.log(`  owed to the issuer ....... ${whole(owed)}`);
  console.log(`  issuer holds ............. ${whole(await tokenBalance(upside.ataFor(mint, issuer.publicKey)))} RWA`);
  console.log(`  buyer holds .............. ${whole(await tokenBalance(buyerCrwa))} cRWA, ${whole(await tokenBalance(upside.ataFor(mint, buyer.publicKey)))} RWA`);
  console.log(`  treasury ................. ${whole(await tokenBalance(treasuryUsdc))} USDC`);

  const pegHolds = escrowed === supply + owed;
  console.log(`  peg (escrow = cRWA + owed) ${pegHolds ? "holds" : "BROKEN"}`);
  console.log(`\n  RWA mint:  ${mint.toBase58()}`);
  console.log(`  cRWA mint: ${crwa.publicKey.toBase58()}`);
  console.log(`  last tx:   ${explorer(lastSig)}\n`);
  if (!pegHolds) process.exit(1);
}

/**
 * The stand-in USDC is a plain SPL mint with no metadata, and it gets a new address every time the
 * node is wiped. Point the app's label at it so the UI says "USDC" rather than "tokens". Only the
 * VITE_QUOTE_LABELS line of app/.env.local (git-ignored) is touched; Vite reloads on the change.
 */
function labelQuoteForApp(usdcMint: PublicKey) {
  const file = "app/.env.local";
  if (!fs.existsSync("app")) return;
  const line = `VITE_QUOTE_LABELS=${usdcMint.toBase58()}=USDC`;
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "VITE_CLUSTER=localnet\nVITE_RPC_URL=http://127.0.0.1:8899\n";
  if (current.includes(line)) return;
  const next = /^VITE_QUOTE_LABELS=.*$/m.test(current)
    ? current.replace(/^VITE_QUOTE_LABELS=.*$/m, line)
    : `${current.replace(/\n?$/, "\n")}${line}\n`;
  fs.writeFileSync(file, next);
  console.log(`  · labelled ${usdcMint.toBase58()} as USDC in ${file}`);
}

/** Printed when a run stops early, so the frontend can be pointed at what was created. */
function summary(stage: StopAt, mint: PublicKey, usdcMint: PublicKey) {
  console.log(`\nStopped at ${stage}.`);
  console.log(`  RWA mint:  ${mint.toBase58()}`);
  console.log(`  USDC mint: ${usdcMint.toBase58()}\n`);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
