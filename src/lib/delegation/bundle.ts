import {buildRedactedExportPayload, type ExportedArtifactRow} from "@/lib/tags/exportFlow";

/**
 * `DelegationCoOwnerBundle` (`specs/vet-public-api.yaml`) - public data only, handed to a newly-
 * added secondary owner's device once `GET /d/:token/status` reports `"added"` (V2's
 * `readyForBundle`). Built to the yaml's own `required` list exactly:
 * `[protocolVersion, dogTagIdField, root, disclosed, obfuscatedLeafHashes, reservedLeafHashes,
 * delegationLeaves, issuerClone, chainId, petName, clinicName]`, plus optional `dogTagIdDec`.
 *
 * Reuses `buildRedactedExportPayload` (the SAME function `/e/:token` exports through) with an
 * EMPTY mask - this ceremony discloses the tag's current custody state exactly as this clinic
 * holds it (whatever was already masked stays masked, per `obfuscatedLeafHashes` already on the
 * artifact), never an additional staff-chosen mask of its own - so this bundle self-checks with
 * the identical `verifyRedactedArtifact` recompute the export ceremony already trusts, rather than
 * a second, independently-maintained assembly of the same fields.
 */
export interface DelegationCoOwnerBundle {
  protocolVersion: string;
  dogTagIdField: string;
  dogTagIdDec?: string;
  root: string;
  disclosed: {keyPath: string; saltHex: string; tag: number; value: string}[];
  obfuscatedLeafHashes: string[];
  reservedLeafHashes: string[];
  delegationLeaves: string[];
  issuerClone: string;
  chainId: number;
  petName: string;
  clinicName: string;
}

export type BuildBundleResult = {ok: true; bundle: DelegationCoOwnerBundle} | {ok: false};

export function buildDelegationCoOwnerBundle(
  artifact: Pick<ExportedArtifactRow, "protocolVersion" | "schemaId" | "dogTagIdDec" | "dogTagIdField" | "root" | "leaves" | "obfuscatedLeafHashes" | "reservedLeafHashes" | "issuerClone">,
  context: {
    /** `DelegationRegistry.delegationLeaves(dogTagId)` - a LIVE chain read, all 16 values, never
     * reconstructed from anything stored in Mongo (`specs/vet-public-api.yaml`: "folding fewer than
     * 16 values produces a different tree than the one delegationRoot actually commits to"). */
    delegationLeaves: string[];
    chainId: number;
    petName: string;
    clinicName: string;
  },
): BuildBundleResult {
  const exported = buildRedactedExportPayload(artifact, []);
  if (!exported.ok) return {ok: false};

  return {
    ok: true,
    bundle: {
      protocolVersion: exported.data.protocolVersion,
      dogTagIdField: exported.data.dogTagIdField,
      dogTagIdDec: exported.data.dogTagIdDec,
      root: exported.data.root,
      disclosed: exported.data.disclosed,
      obfuscatedLeafHashes: exported.data.obfuscatedLeafHashes,
      reservedLeafHashes: exported.data.reservedLeafHashes,
      delegationLeaves: context.delegationLeaves,
      issuerClone: exported.data.issuerClone,
      chainId: context.chainId,
      petName: context.petName,
      clinicName: context.clinicName,
    },
  };
}
