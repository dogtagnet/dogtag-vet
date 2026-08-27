import {describe, expect, it} from "vitest";
import {pickDust} from "@/lib/payments/amountBase";

/** Same interleaving technique as `tests/unit/book.concurrency.test.ts`: a random short delay
 * before the synchronous "check unique key, claim it" step so genuinely concurrent `pickDust`
 * calls can race, rather than each call's awaits happening to resolve in program order. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 4)));
}

/** Models `AmountReservation`'s unique-`_id` insert: the network round trip (`tick()`) can be
 * arbitrarily delayed and reordered relative to other concurrent callers, but the
 * check-and-claim itself, once started, is a single indivisible step - exactly what Mongo's
 * unique index on `_id` guarantees for the real adapter (`src/lib/payments/reservations.ts`). */
class InMemoryReservationLedger {
  private claimed = new Set<string>();

  tryReserve = async (candidate: string): Promise<boolean> => {
    await tick();
    if (this.claimed.has(candidate)) return false;
    this.claimed.add(candidate);
    return true;
  };

  size(): number {
    return this.claimed.size;
  }
}

describe("pickDust - concurrency", () => {
  it("never lets two concurrent payment creations on the same rail claim the same amountBase", async () => {
    for (let trial = 0; trial < 20; trial++) {
      const ledger = new InMemoryReservationLedger();
      const base = 5_000_000n;
      const attempts = 12;

      const results = await Promise.all(Array.from({length: attempts}, () => pickDust(base, ledger.tryReserve)));

      expect(new Set(results).size).toBe(attempts); // every result is unique
      expect(ledger.size()).toBe(attempts);
    }
  });

  it("keeps the first caller's dust value when a second call races the identical rail", async () => {
    const ledger = new InMemoryReservationLedger();
    const base = 1_000n;

    const [first, second] = await Promise.all([pickDust(base, ledger.tryReserve), pickDust(base, ledger.tryReserve)]);

    expect(first).not.toBe(second);
    expect(ledger.size()).toBe(2);
  });
});
