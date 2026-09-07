import {NextResponse} from "next/server";
import {getAddress, isAddress, isAddressEqual, recoverTypedDataAddress, zeroAddress} from "viem";
import {connectToDatabase} from "@/lib/db";
import {RecordArtifact, type RecordArtifactDoc} from "@/lib/models/RecordArtifact";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {readIssuedBy, readRecordTypeVaccination} from "@/lib/chainRead";
import {roax} from "@/lib/chains";
import {readJsonBody} from "@/lib/bodyLimit";
import {badRequest, notFound, requireVetSession} from "@/lib/staffApi";

const ATTESTATION_TYPES = {
  IssuerAttestation: [
    {name: "merkleRoot", type: "bytes32"},
    {name: "recordType", type: "bytes32"},
    {name: "issuerContract", type: "address"},
    {name: "issuerName", type: "string"},
    {name: "issuerDomain", type: "string"},
  ],
} as const;

/**
 * Reconstructs the exact EIP-712 domain/message for an active record's attestation, entirely from
 * server-trusted state - `api/tags/issue/[sessionId]/attestation/route.ts`'s own `IssuerAttestation`
 * shape, with `recordType` read as `RECORD_TYPE_VACCINATION()` instead of `RECORD_TYPE_PROFILE()`
 * (the on-chain-read, "never a free string" rule applies identically to both). Shared by GET (which
 * hands this to the client to sign) and POST (which recomputes it independently), so the two can
 * never drift apart.
 */
async function buildRecordAttestationPayload(
  record: Pick<RecordArtifactDoc, "root">,
  cloneAddress: `0x${string}`,
  businessProfile: {name?: string; domain?: string},
) {
  if (!businessProfile.domain) {
    return {error: badRequest("Configure this clinic's issuer domain in Settings before signing an attestation.")};
  }
  const recordType = await readRecordTypeVaccination(cloneAddress).catch(() => null);
  if (!recordType) return {error: badRequest("Could not read RECORD_TYPE_VACCINATION from the clone.")};

  return {
    domain: {
      name: "DogTagIssuerAttestation",
      version: "1",
      chainId: roax.id,
      verifyingContract: cloneAddress,
    } as const,
    types: ATTESTATION_TYPES,
    message: {
      merkleRoot: record.root as `0x${string}`,
      recordType: recordType as `0x${string}`,
      issuerContract: cloneAddress,
      issuerName: businessProfile.name ?? "",
      issuerDomain: businessProfile.domain,
    },
  };
}

/** `GET /api/records/:id/attestation` - builds the EIP-712 domain/message the operator wallet must
 * sign right after `issueRecord` confirms, mirroring `api/tags/issue/[sessionId]/attestation/
 * route.ts`'s own `GET` exactly (vet-gated - same issuance flow `tx`/`confirm` already gate). */
export async function GET(_request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireVetSession();
  if (response) return response;

  const {id: recordId} = await params;
  await connectToDatabase();
  const record = await RecordArtifact.findOne({recordId}).lean<RecordArtifactDoc>();
  if (!record) return notFound("Record not found.");
  if (record.status !== "active" || !record.chain.contract) {
    return badRequest("Only an active record has an attestation to sign.");
  }

  const settings = await getClinicSettings();
  const payload = await buildRecordAttestationPayload(record, record.chain.contract as `0x${string}`, settings.businessProfile);
  if ("error" in payload) return payload.error;
  return NextResponse.json(payload);
}

/**
 * `POST /api/records/:id/attestation {signature}` - stores the signed attestation on the record
 * (`RecordArtifactDoc.attestation`, outside the Merkle root - stamping it never disturbs `root`),
 * mirroring the tag route's fail-closed shape exactly: the domain/message is rebuilt here from the
 * same server-trusted state `GET` used (never trusted from the request body), the signature is
 * independently recovered against it, and the recovered address must equal `issuedBy(root)` on the
 * record's own resolved clone - a body whose signature does not recover to the anchoring operator
 * is rejected outright rather than persisted.
 */
export async function POST(request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireVetSession();
  if (response) return response;

  const {id: recordId} = await params;
  const parsedBody = await readJsonBody(request);
  const body = parsedBody.ok ? (parsedBody.body as {signature?: unknown} | null) : null;
  if (typeof body?.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) {
    return badRequest("signature (a 65-byte 0x-prefixed hex string) is required.");
  }
  const signature = body.signature as `0x${string}`;

  await connectToDatabase();
  const record = await RecordArtifact.findOne({recordId}).lean<RecordArtifactDoc>();
  if (!record) return notFound("Record not found.");
  if (record.status !== "active" || !record.chain.contract) {
    return badRequest("Only an active record can store an attestation.");
  }
  const cloneAddress = record.chain.contract as `0x${string}`;
  const root = record.root as `0x${string}`;

  const settings = await getClinicSettings();
  const payload = await buildRecordAttestationPayload(record, cloneAddress, settings.businessProfile);
  if ("error" in payload) return payload.error;

  let recoveredSigner: `0x${string}`;
  try {
    recoveredSigner = await recoverTypedDataAddress({
      domain: payload.domain,
      types: payload.types,
      primaryType: "IssuerAttestation",
      message: payload.message,
      signature,
    });
  } catch {
    return badRequest("Could not recover a signer from that signature - it does not match the attestation payload.");
  }

  const issuedByRoot = await readIssuedBy(cloneAddress, root).catch(() => null);
  if (!issuedByRoot || !isAddress(issuedByRoot)) {
    return badRequest("Could not read the anchoring operator for this root from the clone.");
  }
  if (isAddressEqual(issuedByRoot, zeroAddress)) {
    return badRequest("This root has not been anchored on the clone yet - nothing to attest to.");
  }
  if (!isAddressEqual(recoveredSigner, issuedByRoot)) {
    return badRequest(
      "The signature does not come from this root's anchoring operator - the clone's own issuedBy record disagrees.",
    );
  }

  await RecordArtifact.updateOne(
    {recordId},
    {
      $set: {
        attestation: {
          domain: payload.domain,
          message: payload.message,
          signature,
          issuerSigner: getAddress(recoveredSigner),
        },
      },
    },
  );

  return NextResponse.json({ok: true, issuerSigner: getAddress(recoveredSigner)});
}
