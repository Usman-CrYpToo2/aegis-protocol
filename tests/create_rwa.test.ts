/**
 * `create_rwa` — launch step 1: build the Real RWA.
 *
 * What these tests are really checking is the authority split, because that is the whole design:
 * the issuer must end up with complete legal control of the security, and Aegis must end up with
 * none. Everything else (decimals, supply cap, the pinned transfer hook) exists so that the
 * token is guaranteed launchable by Meteora and enforceable by Upside later on.
 */
import { assert } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getPermanentDelegate,
  getTransferHook,
  unpackMint,
} from "@solana/spl-token";
import {
  ALL_ROLES,
  Env,
  ROLE,
  SOL,
  TRANSFER_RESTRICTIONS_PROGRAM_ID,
  accessControl,
  defaultRwaArgs,
  expectAnchorError,
  expectFailure,
  walletRoleBitmask,
} from "./helpers";

function readMint(env: Env, mint: PublicKey) {
  const acc = env.svm.getAccount(mint);
  assert.isNotNull(acc, "mint account should exist");
  return unpackMint(
    mint,
    {
      ...acc!,
      data: Buffer.from(acc!.data),
    } as any,
    TOKEN_2022_PROGRAM_ID
  );
}

describe("create_rwa", () => {
  describe("happy path", () => {
    let env: Env;
    let mint: Keypair;
    let treasuryBefore: bigint;

    before(async () => {
      env = await Env.booted();
      treasuryBefore = env.balance(env.treasury.publicKey);
      mint = await env.createRwa();
    });

    it("creates a Token-2022 mint with zero supply", () => {
      const acc = env.svm.getAccount(mint.publicKey)!;
      assert.equal(
        new PublicKey(acc.owner).toBase58(),
        TOKEN_2022_PROGRAM_ID.toBase58(),
        "must be Token-2022, not the legacy token program"
      );

      const m = readMint(env, mint.publicKey);
      assert.equal(m.decimals, 6);
      assert.equal(m.supply, 0n, "nothing is minted until fund_vault");
    });

    it("hands every mint-level authority to Upside, not to a wallet", () => {
      const m = readMint(env, mint.publicKey);
      const acPda = Env.accessControlPda(mint.publicKey);

      // This is what makes the role bitmask the real authority model: no wallet can mint,
      // freeze, or use the permanent delegate directly. Everything has to go through Upside,
      // which checks roles first.
      assert.equal(m.mintAuthority?.toBase58(), acPda.toBase58());
      assert.equal(m.freezeAuthority?.toBase58(), acPda.toBase58());
      assert.equal(
        getPermanentDelegate(m)?.delegate.toBase58(),
        acPda.toBase58()
      );
    });

    it("pins the transfer hook to Upside Transfer Restrictions", () => {
      const m = readMint(env, mint.publicKey);
      const hook = getTransferHook(m);
      assert.isNotNull(hook, "the RWA must carry a transfer hook");
      assert.equal(
        hook!.programId.toBase58(),
        TRANSFER_RESTRICTIONS_PROGRAM_ID.toBase58(),
        "the hook is what makes KYC enforceable on unwrap — it cannot be anything else"
      );
    });

    it("gives the issuer all four Upside roles", () => {
      const roleAcc = Env.walletRolePda(mint.publicKey, env.issuer.publicKey);
      const bitmask = walletRoleBitmask(env.accountData(roleAcc));

      assert.equal(
        bitmask,
        ALL_ROLES,
        "the issuer is the legal issuer of a security and must retain full control"
      );
      assert.equal(bitmask & ROLE.CONTRACT_ADMIN, ROLE.CONTRACT_ADMIN);
      assert.equal(bitmask & ROLE.RESERVE_ADMIN, ROLE.RESERVE_ADMIN);
      assert.equal(bitmask & ROLE.WALLETS_ADMIN, ROLE.WALLETS_ADMIN);
      assert.equal(bitmask & ROLE.TRANSFER_ADMIN, ROLE.TRANSFER_ADMIN);
    });

    it("gives Aegis no role over the legal token", () => {
      // The launch PDA is the closest thing Aegis has to an identity here. It must not hold a
      // role account at all.
      const aegisRole = Env.walletRolePda(
        mint.publicKey,
        Env.launchPda(mint.publicKey)
      );
      assert.isFalse(
        env.exists(aegisRole),
        "Aegis must never hold an Upside role — that is the issuer's legal responsibility"
      );
    });

    it("caps the supply at exactly the launch supply", () => {
      const ac = accessControl(
        env.accountData(Env.accessControlPda(mint.publicKey))
      );
      const args = defaultRwaArgs();

      assert.equal(ac.mint.toBase58(), mint.publicKey.toBase58());
      assert.equal(
        ac.maxTotalSupply.toString(),
        args.totalSupply.toString(),
        "no headroom to mint into: raising the cap would be a visible on-chain change"
      );
      assert.isNull(
        ac.lockupEscrowAccount,
        "no escrow is registered — Aegis cannot be one, see findings-step1.md"
      );
    });

    it("records the launch at stage TokenCreated", () => {
      const launch = env.launch(mint.publicKey);
      const args = defaultRwaArgs();

      assert.equal(launch.issuer.toBase58(), env.issuer.publicKey.toBase58());
      assert.equal(
        launch.realRwaMint.toBase58(),
        mint.publicKey.toBase58()
      );
      assert.equal(launch.totalSupply.toString(), args.totalSupply.toString());
      assert.equal(launch.decimals, 6);
      assert.deepEqual(launch.stage, { tokenCreated: {} });

      // Nothing is locked or wrapped yet, and the peg ledger starts balanced at zero.
      assert.equal(launch.realRwaLocked.toString(), "0");
      assert.equal(launch.crwaMinted.toString(), "0");

      // cRWA cannot exist yet: Meteora creates that mint inside its own pool-init instruction.
      assert.equal(launch.crwaMint.toBase58(), PublicKey.default.toBase58());
      assert.equal(launch.escrowVault.toBase58(), PublicKey.default.toBase58());
    });

    it("pays the creation fee to the treasury", () => {
      const cfg = env.platformConfig();
      const delta = env.balance(env.treasury.publicKey) - treasuryBefore;
      assert.equal(
        delta.toString(),
        cfg.creationFeeLamports.toString(),
        "the platform fee must actually move, not just be configured"
      );
      assert.equal(cfg.creationFeeLamports.toString(), SOL.toString());
    });
  });

  describe("validation", () => {
    let env: Env;

    beforeEach(async () => {
      env = await Env.booted();
    });

    const tryCreate = async (
      args = defaultRwaArgs(),
      feeRecipient?: PublicKey
    ) => {
      const mint = Keypair.generate();
      const ix = await env.createRwaIx({
        issuer: env.issuer.publicKey,
        realRwaMint: mint.publicKey,
        feeRecipient: feeRecipient ?? env.treasury.publicKey,
        args,
      });
      return env.send([ix], [env.issuer, mint]);
    };

    // Meteora rejects token_decimal outside 6..=9, and the cRWA inherits this value. A mint
    // created outside the range would pass here and then be unlaunchable, so it is caught now.
    it("rejects decimals below 6", async () => {
      expectAnchorError(
        await tryCreate(defaultRwaArgs({ decimals: 5 })),
        "InvalidRwaDecimals"
      );
    });

    it("rejects decimals above 9", async () => {
      expectAnchorError(
        await tryCreate(defaultRwaArgs({ decimals: 10 })),
        "InvalidRwaDecimals"
      );
    });

    it("accepts the 6..=9 boundaries", async () => {
      for (const decimals of [6, 7, 8, 9]) {
        const mint = Keypair.generate();
        const ix = await env.createRwaIx({
          issuer: env.issuer.publicKey,
          realRwaMint: mint.publicKey,
          feeRecipient: env.treasury.publicKey,
          args: defaultRwaArgs({ decimals }),
        });
        env.sendOk([ix], [env.issuer, mint]);
        assert.equal(readMint(env, mint.publicKey).decimals, decimals);
      }
    });

    it("rejects zero supply", async () => {
      expectAnchorError(
        await tryCreate(defaultRwaArgs({ totalSupply: 0 })),
        "InvalidTotalSupply"
      );
    });

    it("rejects an over-long name", async () => {
      expectAnchorError(
        await tryCreate(defaultRwaArgs({ name: "x".repeat(33) })),
        "TokenNameTooLong"
      );
    });

    it("rejects an over-long symbol", async () => {
      expectAnchorError(
        await tryCreate(defaultRwaArgs({ symbol: "x".repeat(11) })),
        "TokenSymbolTooLong"
      );
    });

    it("rejects an over-long uri", async () => {
      expectAnchorError(
        await tryCreate(defaultRwaArgs({ uri: "x".repeat(201) })),
        "TokenUriTooLong"
      );
    });

    it("rejects launches while the protocol is paused", async () => {
      await env.setPaused(true);
      expectAnchorError(await tryCreate(), "ProtocolPaused");

      // and works again once unpaused, so the switch is not one-way
      await env.setPaused(false);
      const mint = Keypair.generate();
      const ix = await env.createRwaIx({
        issuer: env.issuer.publicKey,
        realRwaMint: mint.publicKey,
        feeRecipient: env.treasury.publicKey,
        args: defaultRwaArgs(),
      });
      env.sendOk([ix], [env.issuer, mint]);
    });

    // Without this constraint an issuer could name themselves as the fee recipient and launch
    // for free.
    it("rejects a fee recipient that is not the configured treasury", async () => {
      expectAnchorError(
        await tryCreate(defaultRwaArgs(), env.outsider.publicKey),
        "InvalidFeeRecipient"
      );
    });
  });

  describe("account substitution", () => {
    let env: Env;

    beforeEach(async () => {
      env = await Env.booted();
    });

    it("rejects a launch record at the wrong address", async () => {
      const mint = Keypair.generate();
      const decoy = Keypair.generate();
      const ix = await env.createRwaIx({
        issuer: env.issuer.publicKey,
        realRwaMint: mint.publicKey,
        feeRecipient: env.treasury.publicKey,
        args: defaultRwaArgs(),
        // a launch PDA derived from a different mint
        launch: Env.launchPda(decoy.publicKey),
      });
      expectFailure(env.send([ix], [env.issuer, mint]));
    });

    it("rejects an Upside access-control account at the wrong address", async () => {
      const mint = Keypair.generate();
      const decoy = Keypair.generate();
      const ix = await env.createRwaIx({
        issuer: env.issuer.publicKey,
        realRwaMint: mint.publicKey,
        feeRecipient: env.treasury.publicKey,
        args: defaultRwaArgs(),
        accessControl: Env.accessControlPda(decoy.publicKey),
      });
      expectFailure(env.send([ix], [env.issuer, mint]));
    });

    it("rejects a role account belonging to someone other than the issuer", async () => {
      const mint = Keypair.generate();
      const ix = await env.createRwaIx({
        issuer: env.issuer.publicKey,
        realRwaMint: mint.publicKey,
        feeRecipient: env.treasury.publicKey,
        args: defaultRwaArgs(),
        issuerWalletRole: Env.walletRolePda(
          mint.publicKey,
          env.outsider.publicKey
        ),
      });
      expectFailure(env.send([ix], [env.issuer, mint]));
    });

    // One launch per asset has to be structural, not a runtime check, otherwise two launches
    // could claim backing from the same escrowed supply.
    it("rejects a second launch for the same mint", async () => {
      const args = defaultRwaArgs();
      const mint = await env.createRwa(args);

      const ix = await env.createRwaIx({
        issuer: env.issuer.publicKey,
        realRwaMint: mint.publicKey,
        feeRecipient: env.treasury.publicKey,
        args,
      });
      expectFailure(env.send([ix], [env.issuer, mint]));
    });
  });

  describe("multiple launches", () => {
    it("keeps launches independent", async () => {
      const env = await Env.booted();

      const a = await env.createRwa(
        defaultRwaArgs({ name: "Tower A", symbol: "TWRA", totalSupply: 1_000 })
      );
      const b = await env.createRwa(
        defaultRwaArgs({
          name: "Tower B",
          symbol: "TWRB",
          totalSupply: 2_000,
          decimals: 9,
        })
      );

      const la = env.launch(a.publicKey);
      const lb = env.launch(b.publicKey);

      assert.equal(la.totalSupply.toString(), "1000");
      assert.equal(lb.totalSupply.toString(), "2000");
      assert.equal(la.decimals, 6);
      assert.equal(lb.decimals, 9);
      assert.notEqual(
        Env.launchPda(a.publicKey).toBase58(),
        Env.launchPda(b.publicKey).toBase58()
      );
    });

    it("lets a different issuer launch their own asset", async () => {
      const env = await Env.booted();
      const mint = await env.createRwa(defaultRwaArgs(), env.outsider);

      const launch = env.launch(mint.publicKey);
      assert.equal(launch.issuer.toBase58(), env.outsider.publicKey.toBase58());

      // roles follow the actual issuer, not whoever created the first launch
      assert.equal(
        walletRoleBitmask(
          env.accountData(
            Env.walletRolePda(mint.publicKey, env.outsider.publicKey)
          )
        ),
        ALL_ROLES
      );
      assert.isFalse(
        env.exists(Env.walletRolePda(mint.publicKey, env.issuer.publicKey))
      );
    });
  });
});
