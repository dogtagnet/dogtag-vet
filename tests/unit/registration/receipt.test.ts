import {describe, expect, it} from "vitest";
import {recoverTypedDataAddress} from "viem";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import type {Address} from "viem";
import {
  CLIENT_REGISTRATION_PRIMARY_TYPE,
  CLIENT_REGISTRATION_TYPES,
  buildClientRegistrationDomain,
  canonicalPayloadJson,
  fromWireMessage,
  toWireMessage,
} from "@/lib/registration/eip712";
import {computeReceiptHash, decodeReceiptPayload, receiptExportJson, verifyReceiptExport, type ReceiptExport} from "@/lib/registration/receipt";

/** A real, fully-signed receipt export built from scratch (no fakes anywhere in the crypto path)
 * so `receipt.test.ts` and `scripts/verify-receipt.ts` exercise the exact same shape a real
 * registration produces. */
async function buildSignedReceiptExport(overrides?: Partial<ReceiptExport>): Promise<{account: ReturnType<typeof privateKeyToAccount>; entry: ReceiptExport}> {
  const account = privateKeyToAccount(generatePrivateKey());
  const domain = buildClientRegistrationDomain(135, "0x7b9bf16f0e39AdF8c38d8491F4C7E9C17E85D703");
  const message = fromWireMessage({
    clinic: domain.verifyingContract,
    clientHash: `0x${"ab".repeat(32)}`,
    registrationId: `0x${"cd".repeat(32)}`,
    wallet: account.address,
    issuedAt: "1735689600",
    blockNumber: "42",
    deadline: "1735690200",
  });
  const signature = await account.signTypedData({
    domain,
    types: CLIENT_REGISTRATION_TYPES,
    primaryType: CLIENT_REGISTRATION_PRIMARY_TYPE,
    message,
  });
  const payloadJson = canonicalPayloadJson(domain, toWireMessage(message));
  const receipt = {payloadJson, signature, recoveredAt: 1735689601};
  const entry: ReceiptExport = {
    address: account.address,
    registrationId: "cdcdcdcd-cdcd-cdcd-cdcd-cdcdcdcdcdcd",
    receipt,
    receiptHash: computeReceiptHash(receipt),
    issuedAt: 1735689600,
    blockNumber: 42,
    registeredAt: 1735689601,
    ...overrides,
  };
  return {account, entry};
}

describe("computeReceiptHash", () => {
  it("is deterministic for identical input", () => {
    const receipt = {payloadJson: '{"a":1}', signature: "0xabc" as const, recoveredAt: 100};
    expect(computeReceiptHash(receipt)).toBe(computeReceiptHash({...receipt}));
  });

  it("changes if payloadJson changes", () => {
    const a = computeReceiptHash({payloadJson: '{"a":1}', signature: "0xabc", recoveredAt: 100});
    const b = computeReceiptHash({payloadJson: '{"a":2}', signature: "0xabc", recoveredAt: 100});
    expect(a).not.toBe(b);
  });

  it("changes if signature changes", () => {
    const a = computeReceiptHash({payloadJson: '{"a":1}', signature: "0xabc", recoveredAt: 100});
    const b = computeReceiptHash({payloadJson: '{"a":1}', signature: "0xdef", recoveredAt: 100});
    expect(a).not.toBe(b);
  });

  it("changes if recoveredAt changes", () => {
    const a = computeReceiptHash({payloadJson: '{"a":1}', signature: "0xabc", recoveredAt: 100});
    const b = computeReceiptHash({payloadJson: '{"a":1}', signature: "0xabc", recoveredAt: 101});
    expect(a).not.toBe(b);
  });

  it("returns a 0x-prefixed 32-byte hex value", () => {
    expect(computeReceiptHash({payloadJson: "{}", signature: "0x00", recoveredAt: 0})).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("decodeReceiptPayload - the Wallets panel's expanded receipt view decodes payloadJson back into its domain/message fields (plans/wp4.2-client-wallet-registration.md, round-1 frontendDesignMatch fix: on-screen fields render through AddressChip/HashCell, never a raw JSON dump)", () => {
  it("decodes a real signed payload back into its exact domain and wire-message fields", async () => {
    const {entry} = await buildSignedReceiptExport();
    const decoded = decodeReceiptPayload(entry.receipt.payloadJson);
    expect(decoded).not.toBeNull();
    const expected = JSON.parse(entry.receipt.payloadJson);
    expect(decoded).toEqual(expected);
  });

  it("returns null (never throws) for a payloadJson that is not valid JSON", () => {
    expect(decodeReceiptPayload("{not json")).toBeNull();
  });

  it("returns null (never throws) for well-formed JSON that is not a ClientRegistration payload shape", () => {
    expect(decodeReceiptPayload(JSON.stringify({not: "a payload"}))).toBeNull();
    expect(decodeReceiptPayload(JSON.stringify({domain: {}, message: {}}))).toBeNull();
  });
});

describe("receiptExportJson / verifyReceiptExport round trip - the UI download and the CLI script must agree byte-for-byte", () => {
  it("accepts exactly what receiptExportJson produces, and reports a valid signature + matching hash", async () => {
    const {account, entry} = await buildSignedReceiptExport();
    const json = receiptExportJson(entry);
    const parsedBackFromFile = JSON.parse(json); // simulates reading the downloaded file back off disk

    const result = await verifyReceiptExport(parsedBackFromFile);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.recoveredSigner.toLowerCase()).toBe(account.address.toLowerCase());
    expect(result.addressMatches).toBe(true);
    expect(result.receiptHashMatches).toBe(true);
  });

  it("flags a receiptHash that does not match the payload (tampered or corrupted file)", async () => {
    const {entry} = await buildSignedReceiptExport();
    const tampered = {...entry, receiptHash: `0x${"00".repeat(32)}` as Address};
    const result = await verifyReceiptExport(JSON.parse(receiptExportJson(tampered)));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.receiptHashMatches).toBe(false);
  });

  it("flags an address that does not match the recovered signer (tampered address field)", async () => {
    const {entry} = await buildSignedReceiptExport();
    const otherAddress = privateKeyToAccount(generatePrivateKey()).address;
    const tampered = {...entry, address: otherAddress};
    const result = await verifyReceiptExport(JSON.parse(receiptExportJson(tampered)));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.addressMatches).toBe(false);
  });

  it("rejects a malformed export (not an object with the expected fields) without throwing", async () => {
    const result = await verifyReceiptExport({not: "a receipt"});
    expect(result.ok).toBe(false);
  });

  it("rejects a payloadJson that is not valid JSON without throwing", async () => {
    const {entry} = await buildSignedReceiptExport();
    const tampered = {...entry, receipt: {...entry.receipt, payloadJson: "{not json"}};
    const result = await verifyReceiptExport(JSON.parse(receiptExportJson(tampered)));
    expect(result.ok).toBe(false);
  });

  it("preserves an optional label and revokedAt through the round trip, and omits them when absent", async () => {
    const {entry} = await buildSignedReceiptExport({label: "Primary wallet", revokedAt: 1735700000});
    const roundTripped = JSON.parse(receiptExportJson(entry));
    expect(roundTripped.label).toBe("Primary wallet");
    expect(roundTripped.revokedAt).toBe(1735700000);

    const {entry: withoutOptional} = await buildSignedReceiptExport();
    const roundTrippedWithout = JSON.parse(receiptExportJson(withoutOptional));
    expect("label" in roundTrippedWithout).toBe(false);
    expect("revokedAt" in roundTrippedWithout).toBe(false);
  });

  it("independent sanity check: recoverTypedDataAddress called directly agrees with verifyReceiptExport's own recovery", async () => {
    const {account, entry} = await buildSignedReceiptExport();
    const payload = JSON.parse(entry.receipt.payloadJson);
    const directlyRecovered = await recoverTypedDataAddress({
      domain: payload.domain,
      types: CLIENT_REGISTRATION_TYPES,
      primaryType: CLIENT_REGISTRATION_PRIMARY_TYPE,
      message: fromWireMessage(payload.message),
      signature: entry.receipt.signature as `0x${string}`,
    });
    expect(directlyRecovered.toLowerCase()).toBe(account.address.toLowerCase());
  });
});
