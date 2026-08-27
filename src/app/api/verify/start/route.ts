import {NextResponse} from "next/server";
import {randomBytes} from "node:crypto";
import {connectToDatabase} from "@/lib/db";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {VerifySession} from "@/lib/models/VerifySession";
import {startVerifySessionSchema} from "@/lib/schemas/verifySession";
import {requireEnv} from "@/lib/env";
import {readCanVerify} from "@/lib/chainRead";
import {getServerEnv} from "@/lib/env";
import {badRequest, requireStaffSession} from "@/lib/staffApi";

const CHALLENGE_TTL_SECS = 600;

/**
 * `POST /api/verify/start` - wp4-vet.md's `/verify` flow: staff picks a purpose/recordType/pet,
 * the connected wallet is checked for `canVerify` on `EntityRegistry` (preflight, before creating
 * anything - the banner this fails into names the admin action per wp4-vet.md), then a
 * `VerifySession` is created with a fresh 32-hex token for the QR (`/x/<token>?a=<relayer>`).
 */
export async function POST(request: Request) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const body = await request.json().catch(() => null);
  const parsed = startVerifySessionSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed verify-session request.", parsed.error.flatten());
  const input = parsed.data;

  if (!input.petId) return badRequest("petId is required to look up the on-chain dogTagId.");

  await connectToDatabase();
  const pet = await Pet.findOne({petId: input.petId}).lean<PetDoc>();
  if (!pet?.dogTag.dogTagIdField) return badRequest("This pet has no issued tag.");

  let entityRegistryAddress: `0x${string}`;
  try {
    entityRegistryAddress = requireEnv("ENTITY_REGISTRY_ADDRESS") as `0x${string}`;
  } catch {
    return badRequest("Protocol addresses are not configured.");
  }

  let allowed: boolean;
  try {
    allowed = await readCanVerify(entityRegistryAddress, input.purpose, input.relayerAddress as `0x${string}`);
  } catch {
    return badRequest("Could not reach the chain to check verifier capability.");
  }
  if (!allowed) {
    return badRequest(
      `This wallet does not have canVerify for purpose "${input.purpose}". Ask the DogTag admin to grant it via EntityRegistry.setVerifierCapability.`,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const token = randomBytes(16).toString("hex");
  const session = await VerifySession.create({
    token,
    relayerAddress: input.relayerAddress,
    purpose: input.purpose,
    recordType: input.recordType,
    challenge: {
      dogTagId: pet.dogTag.dogTagIdField,
      deadline: now + CHALLENGE_TTL_SECS,
      consentNonce: randomBytes(16).toString("hex"),
    },
    status: "pending",
    appointmentId: input.appointmentId,
    clientId: input.clientId,
    petId: input.petId,
    disclosedKeyPaths: [],
  });

  const baseUrl = getServerEnv().PUBLIC_BASE_URL ?? new URL(request.url).origin;

  return NextResponse.json(
    {
      sessionId: session.sessionId,
      qr: `${baseUrl.replace(/\/$/, "")}/x/${token}?a=${input.relayerAddress}`,
      deadline: session.challenge.deadline,
    },
    {status: 201},
  );
}
