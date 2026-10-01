import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmSignature, isExpired } from "./send";

type Status = { err: unknown; confirmationStatus: string } | null;

/** A fake connection: `statuses` is what each status check returns, in order; height rises each check. */
function fakeConnection(statuses: Status[], { startHeight = 100 } = {}) {
  let i = 0;
  let height = startHeight;
  const sent: number[] = [];
  return {
    sent,
    conn: {
      getSignatureStatuses: vi.fn(async () => ({ value: [statuses[Math.min(i++, statuses.length - 1)] ?? null] })),
      getBlockHeight: vi.fn(async () => (height += 40)),
      getTransaction: vi.fn(async () => ({ meta: { logMessages: ["Program log: boom"] } })),
      sendRawTransaction: vi.fn(async () => { sent.push(Date.now()); return "sig"; }),
    } as never,
  };
}

describe("confirmSignature", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const run = async (p: Promise<unknown>) => { const settled = p.then(() => "ok", (e) => e); await vi.runAllTimersAsync(); return settled; };

  it("returns once the network reports it confirmed, without any websocket", async () => {
    const { conn } = fakeConnection([null, { err: null, confirmationStatus: "processed" }, { err: null, confirmationStatus: "confirmed" }]);
    expect(await run(confirmSignature(conn, "sig", 1_000))).toBe("ok");
  });

  it("throws the program's error with its logs when the transaction failed", async () => {
    const { conn } = fakeConnection([{ err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" }]);
    const e = await run(confirmSignature(conn, "sig", 1_000));
    expect((e as { logs: string[] }).logs).toEqual(["Program log: boom"]);
  });

  it("calls it expired only when it was never seen and the blockhash ran out", async () => {
    const { conn } = fakeConnection([null], { startHeight: 100 });
    const e = await run(confirmSignature(conn, "sig", 120));
    expect(isExpired(e)).toBe(true);
  });

  it("re-sends the signed bytes while it waits", async () => {
    const { conn, sent } = fakeConnection([null, null, null, null, { err: null, confirmationStatus: "confirmed" }], { startHeight: 0 });
    expect(await run(confirmSignature(conn, "sig", 10_000, new Uint8Array([1])))).toBe("ok");
    expect(sent.length).toBeGreaterThan(0);
  });
});
