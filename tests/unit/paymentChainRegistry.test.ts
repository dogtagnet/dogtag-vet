import {describe, expect, it} from "vitest";
import {Payment} from "@/lib/models/Payment";
import {ClinicSettings} from "@/lib/models/ClinicSettings";
import {ALL_CHAIN_KEYS} from "@/lib/payments/tokenTable";
import {paymentChainKey} from "@/lib/schemas/common";

/**
 * WP4.18 V2 - "a unit test asserts the enums equal the registry keys", so the three Mongoose
 * chainKey enums (Payment.ts's cryptoRailSchema and paidWithSchema, ClinicSettings.ts's
 * receivingAddressSchema) and the zod paymentChainKey enum (schemas/common.ts - the one that
 * actually gates every API request body) can never silently drift from `tokenTable.ts`'s
 * ALL_CHAIN_KEYS again the way plan section 7 anticipates a future second chain being "a config
 * and registry addition, never a rewrite": add a key to ALL_CHAIN_KEYS and one of these four spots
 * forgotten to follow turns this file red by name, rather than shipping a silent mismatch (a rail
 * the registry can build but Mongo refuses to persist, or vice versa).
 *
 * Reads the enum lists through Mongoose's own schema path API (`Model.schema.path(...)`) - proven
 * against a throwaway schema to return `.enumValues` for BOTH a document-array's nested path
 * (`crypto`, `receivingAddresses`) and a single nested subdocument's path (`paidWith`) - rather
 * than exporting the three private `Schema` instances, so this asserts what Mongoose will
 * ACTUALLY enforce on a real write, not a hand-copied constant that could itself drift from the
 * schema.
 */
describe("payment chain registry - enum drift guard", () => {
  const registryKeys = [...ALL_CHAIN_KEYS].sort();

  it("Payment.crypto[].chainKey's enum equals the registry keys", () => {
    const cryptoChainKeyPath = Payment.schema.path("crypto") as unknown as {schema: {path: (name: string) => {enumValues: string[]}}};
    expect([...cryptoChainKeyPath.schema.path("chainKey").enumValues].sort()).toEqual(registryKeys);
  });

  it("Payment.paidWith.chainKey's enum equals the registry keys", () => {
    const paidWithChainKeyPath = Payment.schema.path("paidWith") as unknown as {schema: {path: (name: string) => {enumValues: string[]}}};
    expect([...paidWithChainKeyPath.schema.path("chainKey").enumValues].sort()).toEqual(registryKeys);
  });

  it("ClinicSettings.receivingAddresses[].chainKey's enum equals the registry keys", () => {
    const receivingChainKeyPath = ClinicSettings.schema.path("receivingAddresses") as unknown as {
      schema: {path: (name: string) => {enumValues: string[]}};
    };
    expect([...receivingChainKeyPath.schema.path("chainKey").enumValues].sort()).toEqual(registryKeys);
  });

  it("the zod paymentChainKey enum (which gates every API request body) equals the registry keys", () => {
    expect([...paymentChainKey.options].sort()).toEqual(registryKeys);
  });
});
