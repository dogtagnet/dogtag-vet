import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {MintSession, type MintSessionDoc} from "@/lib/models/MintSession";
import {Pet} from "@/lib/models/Pet";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {readRecordTypeProfile} from "@/lib/chainRead";
import {roax} from "@/lib/chains";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";

/**
 * `GET /api/tags/issue/:sessionId/attestation` - builds the EIP-712 domain/message the operator
 * wallet must sign right after `issueTag` confirms (`protocol/specs/issuer-attestation.md`). The
 * client passes this straight into wagmi's `useSignTypedData`; nothing here signs anything -
 * there is no server-held private key in this repo.
 */
export async function GET(_request: Request, {params}: {params: Promise<{sessionId: string}>}) {
  const {response} = await requireStaffSession();
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

  const recordType = await readRecordTypeProfile(settings.cloneAddress as `0x${string}`).catch(() => null);
  if (!recordType) return badRequest("Could not read RECORD_TYPE_PROFILE from the clone.");

  return NextResponse.json({
    domain: {
      name: "DogTagIssuerAttestation",
      version: "1",
      chainId: roax.id,
      verifyingContract: settings.cloneAddress,
    },
    types: {
      IssuerAttestation: [
        {name: "merkleRoot", type: "bytes32"},
        {name: "recordType", type: "bytes32"},
        {name: "issuerContract", type: "address"},
        {name: "issuerName", type: "string"},
        {name: "issuerDomain", type: "string"},
      ],
    },
    message: {
      merkleRoot: session.root,
      recordType,
      issuerContract: settings.cloneAddress,
      issuerName: settings.businessProfile.name ?? "",
      issuerDomain: settings.businessProfile.contactEmail ?? "",
    },
  });
}

/** `POST /api/tags/issue/:sessionId/attestation {signature, issuerSigner}` - stores the signed
 * attestation with the tag (`protocol/specs/issuer-attestation.md`: "Where it rides" -
 * `Pet.dogTag.attestation`, outside the Merkle root, so stamping it never disturbs `R`). */
export async function POST(request: Request, {params}: {params: Promise<{sessionId: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {sessionId} = await params;
  const body = (await request.json().catch(() => null)) as {signature?: unknown; issuerSigner?: unknown} | null;
  if (typeof body?.signature !== "string" || typeof body?.issuerSigner !== "string") {
    return badRequest("signature and issuerSigner are required.");
  }

  await connectToDatabase();
  const session = await MintSession.findOne({sessionId}).lean<MintSessionDoc>();
  if (!session) return notFound("Mint session not found.");
  if (session.status !== "bound" || !session.root || !session.petId) {
    return badRequest("Only a bound session with a linked pet can store an attestation.");
  }
  const settings = await getClinicSettings();
  if (!settings.cloneAddress) return badRequest("This clinic has not completed setup.");

  const recordType = await readRecordTypeProfile(settings.cloneAddress as `0x${string}`).catch(() => null);
  if (!recordType) return badRequest("Could not read RECORD_TYPE_PROFILE from the clone.");

  await Pet.updateOne(
    {petId: session.petId},
    {
      $set: {
        "dogTag.attestation": {
          domain: {
            name: "DogTagIssuerAttestation",
            version: "1",
            chainId: roax.id,
            verifyingContract: settings.cloneAddress,
          },
          message: {
            merkleRoot: session.root,
            recordType,
            issuerContract: settings.cloneAddress,
            issuerName: settings.businessProfile.name ?? "",
            issuerDomain: settings.businessProfile.contactEmail ?? "",
          },
          signature: body.signature,
          issuerSigner: body.issuerSigner,
        },
      },
    },
  );

  return NextResponse.json({ok: true});
}
