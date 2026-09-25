import {describe, expect, it} from "vitest";
import {encodeAbiParameters, encodeEventTopics, parseAbiParameters} from "viem";
import type {Log} from "viem";
import {vetIssuerAbi} from "@/lib/abi";
import {decodeRefundOutcome, refundFeedbackMessage} from "@/lib/refundFeedback";

const CLONE = "0x1111111111111111111111111111111111111111";
const OTHER_CONTRACT = "0x2222222222222222222222222222222222222222";
const OPERATOR = "0x3333333333333333333333333333333333333333";

/** Mirrors e2e/rpcStub.ts's own `encodeRefundSkippedLog` - a hand-rolled second copy here would
 * risk drifting from the real ABI; this test file is not allowed to import from e2e/ (Node's
 * native ESM loader vs. this app's own bundler - rpcStub.ts's own header comment), so it encodes
 * directly against the SAME vendored ABI `decodeRefundOutcome` itself decodes with. */
function refundSkippedLog(address: string, operator: string, wanted: bigint): Log {
  const topics = encodeEventTopics({abi: vetIssuerAbi, eventName: "RefundSkipped", args: {operator: operator as `0x${string}`}});
  const data = encodeAbiParameters(parseAbiParameters("uint256"), [wanted]);
  return {address, topics, data} as unknown as Log;
}

function tagIssuedLog(address: string): Log {
  // A DIFFERENT event from the same ABI - proves decodeRefundOutcome does not just match "any
  // event from this contract", only specifically RefundSkipped.
  const topics = encodeEventTopics({
    abi: vetIssuerAbi,
    eventName: "TagIssued",
    args: {dogTagIdField: 1n, root: `0x${"11".repeat(32)}` as `0x${string}`},
  });
  const data = "0x" as `0x${string}`;
  return {address, topics, data} as unknown as Log;
}

describe("decodeRefundOutcome (WP4.19 V2 - no GasRefunded event anywhere in this protocol snapshot; 'refunded' is the ABSENCE of RefundSkipped)", () => {
  it("no logs at all -> refunded (nothing was skipped)", () => {
    expect(decodeRefundOutcome([], CLONE)).toBe("refunded");
  });

  it("a RefundSkipped log from the clone -> skipped", () => {
    const logs = [refundSkippedLog(CLONE, OPERATOR, 50_000_000_000_000_000n)];
    expect(decodeRefundOutcome(logs, CLONE)).toBe("skipped");
  });

  it("address match is case-insensitive (checksummed vs lowercase)", () => {
    const checksummed = "0x1111111111111111111111111111111111111111";
    const logs = [refundSkippedLog(checksummed, OPERATOR, 1n)];
    expect(decodeRefundOutcome(logs, CLONE.toUpperCase().replace("0X", "0x"))).toBe("skipped");
  });

  it("a RefundSkipped log from a DIFFERENT contract in the same receipt is ignored -> refunded", () => {
    const logs = [refundSkippedLog(OTHER_CONTRACT, OPERATOR, 1n)];
    expect(decodeRefundOutcome(logs, CLONE)).toBe("refunded");
  });

  it("a different event from the clone (never RefundSkipped) -> refunded, not mistaken for a skip", () => {
    const logs = [tagIssuedLog(CLONE)];
    expect(decodeRefundOutcome(logs, CLONE)).toBe("refunded");
  });

  it("a mix of an unrelated event and a genuine RefundSkipped from the clone -> skipped (order-independent)", () => {
    const logs = [tagIssuedLog(CLONE), refundSkippedLog(CLONE, OPERATOR, 1n)];
    expect(decodeRefundOutcome(logs, CLONE)).toBe("skipped");
  });

  it("a log this ABI cannot decode at all (malformed topics) never throws - treated as not-a-skip", () => {
    const malformed = {address: CLONE, topics: ["0xnotarealtopic"], data: "0x"} as unknown as Log;
    expect(() => decodeRefundOutcome([malformed], CLONE)).not.toThrow();
    expect(decodeRefundOutcome([malformed], CLONE)).toBe("refunded");
  });
});

describe("refundFeedbackMessage", () => {
  it("uses Kenneth's exact copy for a refund", () => {
    expect(refundFeedbackMessage("refunded")).toBe("Gas refunded by the clinic contract");
  });

  it("uses Kenneth's exact copy for a skip", () => {
    expect(refundFeedbackMessage("skipped")).toBe("Refund skipped, the clinic's refund pool is low: tell your admin");
  });
});
