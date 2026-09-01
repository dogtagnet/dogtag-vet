import {NextResponse} from "next/server";
import {getAddress, isAddress, isAddressEqual, recoverTypedDataAddress, zeroAddress} from "viem";
import {connectToDatabase} from "@/lib/db";
import {MintSession, type MintSessionDoc} from "@/lib/models/MintSession";
import {Pet} from "@/lib/models/Pet";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {readIssuedBy, readRecordTypeProfile} from "@/lib/chainRead";
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

/** Reconstructs the exact EIP-712 domain/message for a bound session's attestation, entirely from
 * server-trusted state (the session's own anchored root, the clone's own `RECORD_TYPE_PROFILE`,
 * and this clinic's own configured name/domain) - never from anything a request body supplies.
 * Shared by GET (which hands this to the client to sign) and POST (which recomputes it
 * independently to check what was actually signed), so the two can never drift apart. */
async function buildAttestationPayload(
  session: Pick<MintSessionDoc, "root">,
  cloneAddress: `0x${string}`,
  businessProfile: {name?: string; domain?: string},
) {
  if (!businessProfile.domain) {
    return {error: badRequest("Configure this clinic's issuer domain in Settings before signing an attestation.")};
  }
  const recordType = await readRecordTypeProfile(cloneAddress).catch(() => null);
  if (!recordType) return {error: badRequest("Could not read RECORD_TYPE_PROFILE from the clone.")};

  return {
    domain: {
      name: "DogTagIssuerAttestation",
      version: "1",
      chainId: roax.id,
      verifyingContract: cloneAddress,
    } as const,
    types: ATTESTATION_TYPES,
    message: {
      merkleRoot: session.root as `0x${string}`,
      recordType: recordType as `0x${string}`,
      issuerContract: cloneAddress,
      issuerName: businessProfile.name ?? "",
      issuerDomain: businessProfile.domain,
    },
  };
}

/**
 * `GET /api/tags/issue/:sessionId/attestation` - builds the EIP-712 domain/message the operator
 * wallet must sign right after `issueTag` confirms (`protocol/specs/issuer-attestation.md`). The
 * client passes this straight into wagmi's `useSignTypedData`; nothing here signs anything -
 * there is no server-held private key in this repo.
 *
 * WP4.7A orchestrator ruling R1 (FIX ROUND 1): vet-gated (`requireVetSession`), matching `confirm`/
 * `tx`/`retry` - both handlers below are part of the same issuance flow those three routes already
 * gate, called only from `TagIssueWizard.tsx` under the already page-gated `/tags/issue`.
 */
export async function GET(_request: Request, {params}: {params: Promise<{sessionId: string}>}) {
  const {response} = await requireVetSession();
  if (response) return response;

  const {sessionId} = await params;
  await connectToDatabase();
  const session = await MintSession.findOne({sessionId}).lean<MintSessionDoc>();
  if (!session) return notFound("Mint session not found.");
  if (session.status !== "bound" || !session.root) {
    return badRequest("Only a bound session has an attestation to sign.");
  }
  const settings = await getClinicSettings();
  if (!settings.cloneAddress) return badRequest("This clinic has not completed setup.");

  const payload = await buildAttestationPayload(session, settings.cloneAddress as `0x${string}`, settings.businessProfile);
  if ("error" in payload) return payload.error;
  return NextResponse.json(payload);
}

/**
 * `POST /api/tags/issue/:sessionId/attestation {signature, issuerSigner}` - stores the signed
 * attestation with the tag (`protocol/specs/issuer-attestation.md`: "Where it rides" -
 * `Pet.dogTag.attestation`, outside the Merkle root, so stamping it never disturbs `R`).
 *
 * Fail-closed, unlike the version this replaces: the domain/message signed over is rebuilt here
 * from the same server-trusted state `GET` used (never trusted from the request body), the
 * signature is independently recovered against it (`recoverTypedDataAddress`, not merely stored
 * alongside a client-asserted `issuerSigner`), and the recovered address must equal
 * `VetIssuer.issuedBy(root)` - the on-chain record of who actually anchored this root, which is
 * precisely the check `verify.ts`'s M7 provenance step performs on the far side. A body whose
 * signature does not recover to the anchoring operator is rejected outright rather than persisted.
 */
export async function POST(request: Request, {params}: {params: Promise<{sessionId: string}>}) {
  const {response} = await requireVetSession();
  if (response) return response;

  const {sessionId} = await params;
  const parsedBody = await readJsonBody(request);
  const body = parsedBody.ok ? (parsedBody.body as {signature?: unknown} | null) : null;
  if (typeof body?.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) {
    return badRequest("signature (a 65-byte 0x-prefixed hex string) is required.");
  }
  const signature = body.signature as `0x${string}`;

  await connectToDatabase();
  const session = await MintSession.findOne({sessionId}).lean<MintSessionDoc>();
  if (!session) return notFound("Mint session not found.");
  if (session.status !== "bound" || !session.root || !session.petId) {
    return badRequest("Only a bound session with a linked pet can store an attestation.");
  }
  const settings = await getClinicSettings();
  if (!settings.cloneAddress) return badRequest("This clinic has not completed setup.");
  const cloneAddress = settings.cloneAddress as `0x${string}`;
  const root = session.root as `0x${string}`;

  const payload = await buildAttestationPayload(session, cloneAddress, settings.businessProfile);
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

  await Pet.updateOne(
    {petId: session.petId},
    {
      $set: {
        "dogTag.attestation": {
          domain: payload.domain,
          message: payload.message,
          signature,
          // The recovered address, not a client-asserted claim - it has just been proven to equal
          // `issuedBy(root)` above, so this is now a checked fact rather than an unverified value
          // an offline verifier's M7 provenance check would otherwise be comparing against nothing.
          issuerSigner: getAddress(recoveredSigner),
        },
      },
    },
  );

  return NextResponse.json({ok: true, issuerSigner: getAddress(recoveredSigner)});
}
