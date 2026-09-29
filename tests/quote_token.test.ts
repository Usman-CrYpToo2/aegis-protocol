/**
 * The quote-token whitelist.
 *
 * The quote token is what buyers actually pay with, so an unvetted one makes the soundness of
 * the curve irrelevant. Approval is therefore admin-only.
 *
 * It also enforces Meteora's own rules about which quote mints it will accept. Meteora rejects
 * anything that is not legacy SPL or a bare Token-2022 mint, and a rejection at pool creation
 * would land on an issuer who has already locked their asset in escrow. Failing at approval
 * time makes it the admin's problem instead.
 */
import { assert } from "chai";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  getMintLen,
} from "@solana/spl-token";
import { Env, expectAnchorError, expectFailure, expectSuccess } from "./helpers";

/** Builds a mint of our choosing so each test can vary exactly one property. */
async function makeMint(
  env: Env,
  opts: {
    tokenProgram?: PublicKey;
    extensions?: ExtensionType[];
    decimals?: number;
    withTransferFee?: boolean;
  } = {}
): Promise<Keypair> {
  const tokenProgram = opts.tokenProgram ?? TOKEN_PROGRAM_ID;
  const extensions = opts.extensions ?? [];
  const decimals = opts.decimals ?? 6;
  const mint = Keypair.generate();
  const payer = env.admin;

  const space = getMintLen(extensions);
  const lamports = env.svm.minimumBalanceForRentExemption(BigInt(space));

  const ixs = [
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space,
      lamports: Number(lamports),
      programId: tokenProgram,
    }),
  ];

  // Extensions must be initialized before the mint itself.
  if (opts.withTransferFee) {
    ixs.push(
      createInitializeTransferFeeConfigInstruction(
        mint.publicKey,
        payer.publicKey,
        payer.publicKey,
        100,
        BigInt(1_000_000),
        tokenProgram
      )
    );
  }
  if (extensions.includes(ExtensionType.MetadataPointer)) {
    ixs.push(
      createInitializeMetadataPointerInstruction(
        mint.publicKey,
        payer.publicKey,
        mint.publicKey,
        tokenProgram
      )
    );
  }

  ixs.push(
    createInitializeMintInstruction(
      mint.publicKey,
      decimals,
      payer.publicKey,
      null,
      tokenProgram
    )
  );

  env.sendOk(ixs, [payer, mint]);
  return mint;
}

describe("quote token whitelist", () => {
  describe("approval", () => {
    let env: Env;

    beforeEach(async () => {
      env = await Env.booted();
    });

    it("approves a legacy SPL mint", async () => {
      const mint = await makeMint(env, { tokenProgram: TOKEN_PROGRAM_ID });
      expectSuccess(
        env.send(
          [await env.whitelistQuoteTokenIx(mint.publicKey)],
          [env.admin]
        )
      );

      const qt = env.quoteToken(mint.publicKey);
      assert.equal(qt.mint.toBase58(), mint.publicKey.toBase58());
      assert.equal(qt.decimals, 6);
      assert.isTrue(qt.isActive);
      assert.isTrue(qt.isLegacySpl);
      assert.isAbove(Number(qt.approvedAt), 0);
    });

    it("approves a bare Token-2022 mint", async () => {
      const mint = await makeMint(env, {
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      });
      expectSuccess(
        env.send(
          [await env.whitelistQuoteTokenIx(mint.publicKey)],
          [env.admin]
        )
      );
      assert.isFalse(env.quoteToken(mint.publicKey).isLegacySpl);
    });

    it("approves a Token-2022 mint carrying only a metadata pointer", async () => {
      const mint = await makeMint(env, {
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        extensions: [ExtensionType.MetadataPointer],
      });
      expectSuccess(
        env.send(
          [await env.whitelistQuoteTokenIx(mint.publicKey)],
          [env.admin]
        )
      );
    });

    // A fee-bearing quote mint would make the amount Meteora receives differ from the amount the
    // buyer sent, which quietly breaks the raise accounting. Meteora refuses these; so do we.
    it("rejects a Token-2022 mint with a transfer fee", async () => {
      const mint = await makeMint(env, {
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        extensions: [ExtensionType.TransferFeeConfig],
        withTransferFee: true,
      });
      expectAnchorError(
        env.send(
          [await env.whitelistQuoteTokenIx(mint.publicKey)],
          [env.admin]
        ),
        "UnsupportedQuoteMint"
      );
    });

    it("records the mint's real decimals", async () => {
      const mint = await makeMint(env, { decimals: 9 });
      env.sendOk(
        [await env.whitelistQuoteTokenIx(mint.publicKey)],
        [env.admin]
      );
      assert.equal(env.quoteToken(mint.publicKey).decimals, 9);
    });

    it("cannot approve the same mint twice", async () => {
      const mint = await makeMint(env);
      env.sendOk(
        [await env.whitelistQuoteTokenIx(mint.publicKey)],
        [env.admin]
      );
      expectFailure(
        env.send(
          [await env.whitelistQuoteTokenIx(mint.publicKey)],
          [env.admin]
        )
      );
    });
  });

  describe("authorization", () => {
    it("refuses anyone who is not the protocol admin", async () => {
      const env = await Env.booted();
      const mint = await makeMint(env);
      expectAnchorError(
        env.send(
          [await env.whitelistQuoteTokenIx(mint.publicKey, env.outsider.publicKey)],
          [env.outsider]
        ),
        "Unauthorized"
      );
    });

    it("refuses a non-admin trying to deactivate", async () => {
      const env = await Env.booted();
      const mint = await makeMint(env);
      env.sendOk(
        [await env.whitelistQuoteTokenIx(mint.publicKey)],
        [env.admin]
      );
      expectAnchorError(
        env.send(
          [
            await env.updateQuoteTokenIx(
              mint.publicKey,
              false,
              null,
              env.outsider.publicKey
            ),
          ],
          [env.outsider]
        ),
        "Unauthorized"
      );
    });
  });

  describe("activation", () => {
    let env: Env;
    let mint: Keypair;

    beforeEach(async () => {
      env = await Env.booted();
      mint = await makeMint(env);
      env.sendOk(
        [await env.whitelistQuoteTokenIx(mint.publicKey)],
        [env.admin]
      );
    });

    it("deactivates and reactivates", async () => {
      env.sendOk(
        [await env.updateQuoteTokenIx(mint.publicKey, false)],
        [env.admin]
      );
      assert.isFalse(env.quoteToken(mint.publicKey).isActive);

      env.sendOk(
        [await env.updateQuoteTokenIx(mint.publicKey, true)],
        [env.admin]
      );
      assert.isTrue(env.quoteToken(mint.publicKey).isActive);
    });

    it("rejects a no-op change", async () => {
      expectAnchorError(
        env.send(
          [await env.updateQuoteTokenIx(mint.publicKey, true)],
          [env.admin]
        ),
        "QuoteTokenStatusUnchanged"
      );
    });

    // Deactivation is preferred over closing the account: launches already configured against
    // this quote token keep working, and the address cannot be re-approved with different data.
    it("keeps the record after deactivation", async () => {
      env.sendOk(
        [await env.updateQuoteTokenIx(mint.publicKey, false)],
        [env.admin]
      );
      const qt = env.quoteToken(mint.publicKey);
      assert.equal(qt.mint.toBase58(), mint.publicKey.toBase58());
      assert.equal(qt.decimals, 6);
    });
  });

  describe("independence", () => {
    it("keeps approvals separate per mint", async () => {
      const env = await Env.booted();
      const a = await makeMint(env, { decimals: 6 });
      const b = await makeMint(env, { decimals: 9 });

      env.sendOk([await env.whitelistQuoteTokenIx(a.publicKey)], [env.admin]);
      env.sendOk([await env.whitelistQuoteTokenIx(b.publicKey)], [env.admin]);
      env.sendOk(
        [await env.updateQuoteTokenIx(a.publicKey, false)],
        [env.admin]
      );

      assert.isFalse(env.quoteToken(a.publicKey).isActive);
      assert.isTrue(env.quoteToken(b.publicKey).isActive);
      assert.notEqual(
        Env.quoteTokenPda(a.publicKey).toBase58(),
        Env.quoteTokenPda(b.publicKey).toBase58()
      );
    });

    it("has no record for an unapproved mint", async () => {
      const env = await Env.booted();
      const mint = await makeMint(env);
      assert.isFalse(env.exists(Env.quoteTokenPda(mint.publicKey)));
    });
  });
});
