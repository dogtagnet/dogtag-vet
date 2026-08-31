import {describe, expect, it} from "vitest";
import {canonicalClientJson, computeClientHash} from "@/lib/registration/clientHash";

/**
 * Pins `computeClientHash` against `plans/wp4.2-client-wallet-registration.md`'s "The signed
 * message" section (normative): `clientHash = keccak256(utf8(canonicalJson) || uuidBytes16)`,
 * `canonicalJson` = `{"address":...,"email":...,"name":...,"phone":...}` with sorted keys, values
 * as stored after trim, missing optional fields as empty string, no whitespace.
 *
 * The three `expected` hex values below were computed ONCE by a standalone script driving this
 * repo's own installed viem (`keccak256`/`toBytes`/`concat`) directly against the same
 * canonicalJson strings asserted below - independently of `computeClientHash` itself, the same
 * "viem is the trusted reference implementation on this side of the comparison" methodology
 * `eip712ClientRegistration.vectors.test.ts` documents for the EIP-712 digest fixture. A future
 * bug in `computeClientHash`'s byte-concatenation order or JSON shape fails this test even though
 * both the test and the implementation happen to run through the same keccak256 function, because
 * the expected values were never derived by calling `computeClientHash`.
 */
describe("canonicalClientJson", () => {
  it("sorts keys as address, email, name, phone with no whitespace", () => {
    const json = canonicalClientJson({
      name: "Jordan Alvarez",
      address: "123 Main St, Springfield",
      phone: "+1-555-0100",
      email: "jordan.alvarez@example.com",
    });
    expect(json).toBe(
      '{"address":"123 Main St, Springfield","email":"jordan.alvarez@example.com","name":"Jordan Alvarez","phone":"+1-555-0100"}',
    );
  });

  it("renders missing optional fields as empty strings, never omitted or null", () => {
    expect(canonicalClientJson({name: "A"})).toBe('{"address":"","email":"","name":"A","phone":""}');
  });

  it("trims every value, including the required name", () => {
    expect(canonicalClientJson({name: "  Widget Clinic Owner  ", email: "  owner@widget.example  "})).toBe(
      '{"address":"","email":"owner@widget.example","name":"Widget Clinic Owner","phone":""}',
    );
  });
});

describe("computeClientHash", () => {
  it("matches an independently-computed vector: full fields", () => {
    const input = {
      address: "123 Main St, Springfield",
      email: "jordan.alvarez@example.com",
      name: "Jordan Alvarez",
      phone: "+1-555-0100",
    };
    const registrationId = "8fd81415-a95c-9b04-c6f9-08ec7d0bcf3a";
    expect(computeClientHash(input, registrationId)).toBe(
      "0x6d26c7de1d95f8528605284c63ffaa5beb3fae769305f8d643962e2ceba4b582",
    );
  });

  it("matches an independently-computed vector: name only, all-zero registrationId", () => {
    const registrationId = "00000000-0000-0000-0000-000000000000";
    expect(computeClientHash({name: "A"}, registrationId)).toBe(
      "0x1675ff19c669049a5aa70a1e08881832bc2f1e3a49d0fba97bfda430e1800faa",
    );
  });

  it("matches an independently-computed vector: partial fields + whitespace to trim, all-0xff registrationId", () => {
    const registrationId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    expect(computeClientHash({name: "  Widget Clinic Owner  ", email: "  owner@widget.example  "}, registrationId)).toBe(
      "0x9e1443a42c6a0c32274787a5390f19b124351d0cee28c21e6a49287eaaae804e",
    );
  });

  it("is sensitive to the registrationId, not just the client fields - the same client fields with a different registrationId hash differently", () => {
    const input = {name: "A"};
    const h1 = computeClientHash(input, "00000000-0000-0000-0000-000000000000");
    const h2 = computeClientHash(input, "ffffffff-ffff-ffff-ffff-ffffffffffff");
    expect(h1).not.toBe(h2);
  });

  it("is sensitive to every client field independently", () => {
    const registrationId = "8fd81415-a95c-9b04-c6f9-08ec7d0bcf3a";
    const base = {name: "Jordan Alvarez", email: "a@example.com", phone: "555-0100", address: "1 Main St"};
    const baseHash = computeClientHash(base, registrationId);
    expect(computeClientHash({...base, name: "Jordan Alvarezz"}, registrationId)).not.toBe(baseHash);
    expect(computeClientHash({...base, email: "b@example.com"}, registrationId)).not.toBe(baseHash);
    expect(computeClientHash({...base, phone: "555-0101"}, registrationId)).not.toBe(baseHash);
    expect(computeClientHash({...base, address: "2 Main St"}, registrationId)).not.toBe(baseHash);
  });

  it("returns a 0x-prefixed 32-byte hex value", () => {
    const hash = computeClientHash({name: "A"}, "00000000-0000-0000-0000-000000000000");
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
