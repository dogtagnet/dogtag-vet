import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {Client, type ClientDoc} from "@/lib/models/Client";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {DelegationSession, type DelegationSessionDoc} from "@/lib/models/DelegationSession";
import {startDelegationSchema} from "@/lib/schemas/delegation";
import {badRequest, notFound, requireVetSession} from "@/lib/staffApi";
import {preflightIssuance} from "@/lib/mint/preflight";
import {createAddDelegationSession, createRevokeDelegationSession} from "@/lib/delegation/createSession";
import {checkDelegationCapNotReached} from "@/lib/delegation/flow";
import {clientHasActiveWallet} from "@/lib/delegation/clientWallet";
import {isTerminalSbtStatus} from "@/lib/delegation/constants";
import {maskClientName} from "@/lib/registration/mask";
import {readRoaxBlockNumber, readSbtStatus, readSecondaryCount} from "@/lib/chainRead";
import {roax} from "@/lib/chains";
import {getServerEnv, requireEnv} from "@/lib/env";

/**
 * `POST /api/pets/:id/delegations` - starts EITHER half of the vet-issued secondary-owner
 * ceremony (`docs/DELEGATION.md` sections 4.3/4.5), distinguished by `mode`. Not part of
 * `vet-public-api.yaml` (that spec only covers the `/d/{token}` mobile-facing surface, mirroring
 * how `/api/tags/issue/start` is likewise vet-portal-internal). Shared preconditions for BOTH
 * modes, checked in this order, mirroring `preflightIssuance`'s own "allocate nothing on failure"
 * discipline: vet/owner session -> pet has an issued tag -> the connected operator wallet is
 * whitelisted on this clinic's clone (`preflightIssuance`, unmodified - the exact same gate
 * `/api/tags/issue/start` uses) -> `DELEGATION_REGISTRY_ADDRESS` configured -> the tag's SBT
 * status is not terminal (Kenneth's decision, plan section 9 item 7 - enforced here since
 * `DelegationRegistry.add`/`revoke` deliberately do not check it on chain, see
 * `chainRead.ts`'s `readSbtStatus` doc comment).
 */
export async function POST(request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireVetSession();
  if (response) return response;

  const {id: petId} = await params;
  const body = await request.json().catch(() => null);
  const parsed = startDelegationSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed delegation request.", parsed.error.flatten());
  const input = parsed.data;

  await connectToDatabase();
  const pet = await Pet.findOne({petId}).lean<PetDoc>();
  if (!pet) return notFound("Pet not found.");
  if (!pet.dogTag?.dogTagIdField) return badRequest("This pet has no DogTag issued yet.");
  const dogTagIdField = pet.dogTag.dogTagIdField;

  const preflight = await preflightIssuance(input.operatorAddress as `0x${string}`);
  if (!preflight.ok) return badRequest(preflight.message);

  let delegationRegistryAddress: `0x${string}`;
  let sbtAddress: `0x${string}`;
  try {
    delegationRegistryAddress = requireEnv("DELEGATION_REGISTRY_ADDRESS") as `0x${string}`;
    sbtAddress = requireEnv("DOGTAG_SBT_ADDRESS") as `0x${string}`;
  } catch {
    return badRequest("This clinic has not completed setup for multi-owner tags yet.");
  }

  let sbtStatus: number;
  try {
    sbtStatus = await readSbtStatus(sbtAddress, dogTagIdField);
  } catch {
    return badRequest("Could not reach the chain to check this tag's status. Try again shortly.");
  }
  if (isTerminalSbtStatus(sbtStatus)) {
    return badRequest("This tag's status is frozen (deceased or revoked) - secondary owners can no longer be added or revoked.");
  }

  const now = Math.floor(Date.now() / 1000);
  const settings = await getClinicSettings();
  const clinicName = settings.businessProfile?.name?.trim();

  if (input.mode === "add") {
    if (!clinicName) {
      return badRequest("Set this clinic's name in Settings before adding a secondary owner.");
    }
    const targetClient = await Client.findOne({clientId: input.clientId}).lean<ClientDoc>();
    if (!targetClient) return notFound("Client not found.");
    if (!(await clientHasActiveWallet(input.clientId))) {
      return badRequest("This client has no registered wallet yet - register one first from their client page.");
    }

    const capCheck = await checkDelegationCapNotReached(dogTagIdField, (id) => readSecondaryCount(delegationRegistryAddress, id));
    if (!capCheck.ok) return badRequest(capCheck.message);

    const result = await createAddDelegationSession(now, readRoaxBlockNumber);
    if (!result.ok) return badRequest("Could not reach the chain to fetch the current block number. Try again shortly.");

    await DelegationSession.create({
      token: result.token,
      registrationId: result.registrationId,
      kind: "add",
      petId,
      dogTagIdField,
      dogTagIdDec: pet.dogTag.dogTagIdDec,
      clientId: input.clientId,
      clinic: preflight.cloneAddress.toLowerCase(),
      chainId: roax.id,
      clinicName,
      maskedTargetName: maskClientName(targetClient.name),
      issuedAt: result.issuedAt,
      blockNumber: result.blockNumber,
      deadline: result.deadline,
      status: "pending",
      consumed: false,
    } satisfies Omit<DelegationSessionDoc, "createdAt">);

    const baseUrl = getServerEnv().PUBLIC_BASE_URL ?? new URL(request.url).origin;
    return NextResponse.json(
      {
        registrationId: result.registrationId,
        qr: `${baseUrl.replace(/\/$/, "")}/d/${result.token}`,
        ttlSecs: result.deadline - result.issuedAt,
        issuedAt: result.issuedAt,
      },
      {status: 201},
    );
  }

  // mode === "revoke" - docs/DELEGATION.md section 4.5: no device participation, no QR, no
  // public API surface. Staff already identified WHICH commitment to remove (the Owners card's
  // own chain-authoritative row); this route only needs to know which client that belongs to, so
  // it can snapshot a masked name for the staff-facing status poll.
  const commitment = input.commitment.toLowerCase();
  const activeGrant = await DelegationSession.findOne({dogTagIdField, kind: "add", status: "confirmed", commitment}).lean<DelegationSessionDoc>();
  if (!activeGrant) return notFound("No active secondary owner found for that commitment.");
  const alreadyRevoked = await DelegationSession.findOne({dogTagIdField, kind: "revoke", status: "confirmed", commitment}).lean();
  if (alreadyRevoked) return badRequest("This secondary owner has already been revoked.");

  const targetClient = await Client.findOne({clientId: activeGrant.clientId}).lean<ClientDoc>();
  const result = createRevokeDelegationSession(now);

  await DelegationSession.create({
    token: result.token,
    registrationId: result.registrationId,
    kind: "revoke",
    petId,
    dogTagIdField,
    dogTagIdDec: pet.dogTag.dogTagIdDec,
    clientId: activeGrant.clientId,
    clinic: preflight.cloneAddress.toLowerCase(),
    chainId: roax.id,
    clinicName: clinicName ?? "",
    maskedTargetName: maskClientName(targetClient?.name ?? "Unknown client"),
    commitment,
    issuedAt: result.issuedAt,
    deadline: result.deadline,
    status: "claimed", // no device step for a revoke - claimed immediately, never "pending"
    consumed: true,
    consumedAt: now,
  } satisfies Omit<DelegationSessionDoc, "createdAt">);

  return NextResponse.json({registrationId: result.registrationId}, {status: 201});
}
