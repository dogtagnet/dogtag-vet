import {randomBytes} from "node:crypto";
import {TypeTag} from "@dogtag/standard";
import type {IdentityLeaf, OwnerIdentity} from "@/lib/models/MintSession";

/**
 * Server-generated `owner.identity.*` openings (wp4-vet.md issuance step 3, normative): one leaf
 * per non-blank `ownerIdentity` field, each with a FRESH random 16-byte salt generated here -
 * never client-supplied, never reused across fields or sessions. Low-entropy identity values
 * (a short name, a country code) are brute-forceable from a leaf hash alone without a
 * high-entropy attester salt (dossier finding V11, normative), so the salt is exactly what stands
 * between "the vet attested this owner's identity" and "anyone who sees the tree can guess it".
 */
const KEY_PATH_BY_FIELD: Record<keyof OwnerIdentity, string> = {
  name: "owner.identity.fullName",
  countryOfIdentification: "owner.identity.country",
  identification: "owner.identity.docNumber",
};

export function buildIdentityLeaves(ownerIdentity: OwnerIdentity): IdentityLeaf[] {
  const leaves: IdentityLeaf[] = [];
  for (const field of Object.keys(KEY_PATH_BY_FIELD) as (keyof OwnerIdentity)[]) {
    const value = ownerIdentity[field]?.trim();
    if (!value) continue;
    leaves.push({
      keyPath: KEY_PATH_BY_FIELD[field],
      saltHex: `0x${randomBytes(16).toString("hex")}`,
      tag: TypeTag.String,
      value,
    });
  }
  return leaves;
}
