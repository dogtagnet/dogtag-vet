import {describe, expect, it} from "vitest";
import {allocateInvoiceNumber, formatInvoiceNumber} from "@/lib/payments/invoiceNumber";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 4)));
}

describe("formatInvoiceNumber", () => {
  it("zero-pads the sequence to 6 digits", () => {
    expect(formatInvoiceNumber("INV", 42)).toBe("INV-000042");
    expect(formatInvoiceNumber("INV", 1)).toBe("INV-000001");
    expect(formatInvoiceNumber("INV", 123456)).toBe("INV-123456");
  });
});

describe("allocateInvoiceNumber - counter atomicity", () => {
  it("hands out a strictly distinct, sequential value to every concurrent caller", async () => {
    // Models `Counter.nextSequence`'s real guarantee: `findOneAndUpdate({$inc})` is a single
    // atomic document mutation, so N concurrent increments against the SAME counter document are
    // serialized by MongoDB itself and always produce N distinct consecutive values - never a
    // read-then-write race where two callers see the same "current" value.
    let seq = 0;
    const nextHandle = async () => {
      await tick(); // the network round trip - can reorder relative to other concurrent callers
      seq += 1; // the atomic $inc itself - a single synchronous step once it starts running
      return seq;
    };

    const attempts = 25;
    const numbers = await Promise.all(Array.from({length: attempts}, () => allocateInvoiceNumber({nextHandle}, "INV")));

    expect(new Set(numbers).size).toBe(attempts); // every invoice number is unique
    const sequences = numbers.map((n) => Number(n.split("-")[1]));
    expect(new Set(sequences)).toEqual(new Set(Array.from({length: attempts}, (_, i) => i + 1)));
  });
});
