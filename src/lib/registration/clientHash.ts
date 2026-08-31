import {concat, keccak256, toBytes, type Hex} from "viem";
import {uuidToBytes16} from "@/lib/registration/uuid";

/** The subset of `Client` fields that feed `clientHash` - deliberately structural (not
 * `ClientDoc` itself) so this module stays free of any mongoose/model dependency and is directly
 * importable from `scripts/verify-receipt.ts`. */
export interface ClientHashFields {
  name: string;
  address?: string;
  email?: string;
  phone?: string;
}

/**
 * Builds the exact canonical JSON string `clientHash` hashes over - plans/wp4.2-client-wallet-
 * registration.md, "The signed message" (normative): `{"address":...,"email":...,"name":...,
 * "phone":...}`, sorted keys, values as stored after trim, missing optional fields as empty
 * string, no whitespace. The key order is hardcoded here (not produced by sorting at runtime) so
 * it can never drift with insertion order; it already happens to be alphabetical.
 */
export function canonicalClientJson(fields: ClientHashFields): string {
  return JSON.stringify({
    address: fields.address?.trim() ?? "",
    email: fields.email?.trim() ?? "",
    name: fields.name.trim(),
    phone: fields.phone?.trim() ?? "",
  });
}

/**
 * `clientHash = keccak256(utf8(canonicalJson) || uuidBytes16)`. Computed server-side only: this
 * is an OPAQUE commitment the owner's device receives and signs over without being able to open
 * it - the phone/relayer never sees raw client PII, only this hash plus the masked name
 * (`maskClientName`) and the clinic's own display name. See docs/client-wallet-registration.md's
 * trust-model section for why the owner is vouching for the clinic + masked name shown on screen,
 * not for the PII contents this hash commits to.
 */
export function computeClientHash(fields: ClientHashFields, registrationId: string): Hex {
  return keccak256(concat([toBytes(canonicalClientJson(fields)), uuidToBytes16(registrationId)]));
}
