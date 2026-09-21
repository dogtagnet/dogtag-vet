import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from "vitest";
import mongoose from "mongoose";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * WP4.18 - regression test for a cursor-persistence bug `e2e/roax-payment.spec.ts` discovered (the
 * FIRST thing to ever drive `runPaymentWatcherOnce`/`scanChain` through more than one real tick
 * against a real Mongo cursor - see `watcher.ts`'s own doc comment on the fix for the full
 * derivation). Bug: on the first-ever observation of a chain, the cursor-write guard
 * (`newCursor >= fromBlock - 1n`) compared against `fromBlock` (redefined to `latest` in that
 * mode, since there is no real cursor yet) rather than "is there anything to regress from at
 * all" - so for ANY confirmations value >= 2 (every confirmations env this app has ever shipped,
 * CONFIRMATIONS_ROAX's default of 2 included), the cursor was NEVER durably written on the first
 * tick, so EVERY later tick also ran in first-ever mode (always rescanning only the current tip,
 * one block), and a transfer that had already landed by the first tick could never be
 * rediscovered - the payment watcher would never mark ANY payment paid automatically.
 *
 * A fake `PublicClient` (only `getBlockNumber`/`getBlock`/`getContractEvents`, the three methods
 * `scanChain` actually calls) stands in for `paymentPublicClient` via `vi.mock`, so this test gets
 * real Mongo-backed `PaymentChainCursor`/`Payment` persistence across TWO REAL calls to
 * `runPaymentWatcherOnce` - the same function `e2e/runPaymentWatcher.ts` invokes - without needing
 * a real HTTP RPC stub.
 *
 * ISOLATION: own ephemeral mongod, port 44148 (44117-44147 already taken by sibling suites).
 */
vi.mock("@/lib/paymentChainRead", () => ({paymentPublicClient: vi.fn()}));

import {paymentPublicClient} from "@/lib/paymentChainRead";
import {connectToDatabase} from "@/lib/db";
import {runPaymentWatcherOnce} from "@/lib/payments/watcher";
import {Payment, type PaymentDoc} from "@/lib/models/Payment";
import {PaymentChainCursor} from "@/lib/models/PaymentChainCursor";
import {ClinicSettings} from "@/lib/models/ClinicSettings";

const MONGO_PORT = 44_148;
let ephemeral: EphemeralMongod;
const RECEIVING = "0x" + "aa".repeat(20);
const SENDER = "0x" + "cc".repeat(20);

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-watcher-cursor");
  process.env.MONGODB_URI = ephemeral.uri;
  await connectToDatabase();
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(MONGO_PORT);
  expect(mongoose.connection.name).toBe("dogtag-vet-watcher-cursor");
}, 90_000);

afterAll(async () => {
  await mongoose.connection.close();
  await stopEphemeralMongod(ephemeral);
});

beforeEach(async () => {
  process.env.CONFIRMATIONS_ROAX = "2";
  process.env.PAYMENT_ACTIVITY_CHUNK_BLOCKS_ROAX = "200";
});

afterEach(async () => {
  await Promise.all([Payment.deleteMany({}), PaymentChainCursor.deleteMany({}), ClinicSettings.deleteMany({})]);
  vi.mocked(paymentPublicClient).mockReset();
});

/** A fake chain whose `blockNumber` advances by exactly one on every `getBlockNumber()` call,
 * mirroring `e2e/rpcStub.ts`'s own `eth_blockNumber` handler exactly (the real behavior this test
 * stands in for). `blocks` maps a block number to the native transactions in it (empty for any
 * unscripted block); `erc20Logs` is unused here (this bug is chain-agnostic, so one native
 * fixture proves it - `tests/unit/watcher.test.ts` already covers the RUSD path independently). */
function fakeChain(startBlock: bigint) {
  let counter = startBlock;
  const blocks = new Map<string, {to: string; from: string; value: bigint; hash: string}[]>();
  return {
    scriptBlock: (blockNumber: bigint, txs: {to: string; from: string; value: bigint; hash: string}[]) => {
      blocks.set(blockNumber.toString(), txs);
    },
    client: {
      getBlockNumber: async () => {
        counter += 1n;
        return counter;
      },
      getBlock: async ({blockNumber}: {blockNumber: bigint}) => ({
        transactions: (blocks.get(blockNumber.toString()) ?? []).map((tx) => ({
          hash: tx.hash,
          to: tx.to,
          from: tx.from,
          value: tx.value,
        })),
      }),
      getContractEvents: async () => [],
    },
  };
}

describe("payment watcher - cursor persists past the first observation (regression)", () => {
  it("a first-ever tick persists a usable cursor, and a second tick then finds and confirms a transfer that landed exactly one block behind the first tick's tip", async () => {
    await ClinicSettings.create({_id: "singleton", receivingAddresses: [{chainKey: "roax", address: RECEIVING}]});
    const payment = await Payment.create({
      invoiceNumber: "INV-WATCHER-1",
      lineItems: [{description: "Checkup", qty: 1, unitAmount: "75.00", amount: "75.00"}],
      currency: "USD",
      subtotal: "75.00",
      total: "75.00",
      status: "pending",
      crypto: [
        {
          chainKey: "roax",
          token: "PLASMA",
          decimals: 18,
          quotedRate: "2500.00",
          amountBase: "30000000000000000",
          receivingAddress: RECEIVING,
          eip681: `ethereum:${RECEIVING}@135?value=30000000000000000`,
        },
      ],
    });

    const chain = fakeChain(1000n); // next getBlockNumber() call returns 1001n
    vi.mocked(paymentPublicClient).mockReturnValue(chain.client as never);
    // Scripted at 1001n - exactly the block tick 1's own getBlockNumber() call will report as "latest".
    chain.scriptBlock(1001n, [{to: RECEIVING, from: SENDER, value: 30_000_000_000_000_000n, hash: "0xplasmatx"}]);

    await runPaymentWatcherOnce(); // tick 1

    const stillPending = await Payment.findOne({paymentId: payment.paymentId}).lean<PaymentDoc>();
    expect(stillPending?.status).toBe("pending"); // only 1 confirmation so far - correctly not yet matched

    // THE REGRESSION ITSELF: before the fix, this cursor document never got written, so tick 2
    // would re-run in first-ever mode and never look at block 1001 again.
    const cursorAfterTick1 = await PaymentChainCursor.findById("roax").lean<{blockNumber: number}>();
    expect(cursorAfterTick1).not.toBeNull();

    await runPaymentWatcherOnce(); // tick 2

    const paid = await Payment.findOne({paymentId: payment.paymentId}).lean<PaymentDoc>();
    expect(paid?.status).toBe("paid");
    expect(paid?.paidWith?.txHash).toBe("0xplasmatx");
  });
});
