import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Pet, buildPetSearchKey} from "@/lib/models/Pet";
import {linkPetToClient} from "@/lib/models/link";
import {MintSession} from "@/lib/models/MintSession";
import {BindToken, generateHexToken} from "@/lib/models/BindToken";
import {nextSequence} from "@/lib/models/Counter";
import {startMintSessionSchema} from "@/lib/schemas/mintSession";
import {badRequest, requireVetSession} from "@/lib/staffApi";
import {preflightIssuance} from "@/lib/mint/preflight";
import {allocateDogTagId} from "@/lib/mint/allocate";
import {isDogTagIdUnset} from "@/lib/mint/chainChecks";
import {buildIdentityLeaves} from "@/lib/mint/identityLeaves";
import {getServerEnv} from "@/lib/env";

const TOKEN_TTL_SECS = 600; // wp4-vet.md issuance step 4: `ttlSecs: 600`

/**
 * `POST /api/tags/issue/start` - wp4-vet.md's `/tags/issue` wizard, step 1->4. Not part of
 * `vet-public-api.yaml` (that spec only covers the mobile/relayer-facing surface).
 * Preflight-then-allocate ordering is load-bearing: `preflightIssuance` runs and can fail BEFORE
 * `allocateDogTagId` ever touches the counter, so a misconfigured clinic never burns a dogTagId
 * for a request that was always going to be rejected.
 *
 * WP4.7A orchestrator ruling R1 (FIX ROUND 1): vet-gated (`requireVetSession`), not merely
 * staff-gated - this is the first step of the SAME issuance wizard `confirm`/`tx`/`retry` already
 * gate, and its own call site (`TagIssueWizard.tsx`, under `/tags/issue`) is already redirect-gated
 * for a plain staff member by the page itself; this closes the matching API-level gap so the guard
 * cannot silently drift from the page in a future refactor.
 */
export async function POST(request: Request) {
  const {response} = await requireVetSession();
  if (response) return response;

  const body = await request.json().catch(() => null);
  const parsed = startMintSessionSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed issuance request.", parsed.error.flatten());
  const input = parsed.data;

  const preflight = await preflightIssuance(input.operatorAddress as `0x${string}`);
  if (!preflight.ok) return badRequest(preflight.message);

  await connectToDatabase();

  let petId = input.petId;
  if (!petId) {
    const pet = await Pet.create({
      name: input.petName,
      species: input.profile.species,
      breed: input.profile.breedLabel,
      sex: input.profile.sex,
      dateOfBirth: input.profile.dateOfBirth,
      microchip: input.microchip ?? {},
      weightHistory: input.profile.weightHistory,
      color: input.profile.color,
      registrationId: input.profile.registrationId,
      registrationAuthority: input.profile.registrationAuthority,
      ownerClientIds: [input.clientId],
      dogTag: {},
      searchKey: buildPetSearchKey({name: input.petName, species: input.profile.species, breed: input.profile.breedLabel}),
    });
    petId = pet.petId;
    await linkPetToClient(petId, input.clientId);
  }

  let allocation;
  try {
    allocation = await allocateDogTagId({
      nextHandle: async () => String(await nextSequence("dogTagId")),
      isRootUnset: isDogTagIdUnset,
    });
  } catch {
    return badRequest("Could not reach the chain to allocate a tag id. Try again shortly.");
  }
  if (!allocation.ok) {
    return badRequest("Could not allocate a dogTagId after 256 attempts. Contact support.");
  }

  const identityLeaves = buildIdentityLeaves(input.ownerIdentity);
  const now = Math.floor(Date.now() / 1000);
  const tokenExp = now + TOKEN_TTL_SECS;

  const session = await MintSession.create({
    dogTagIdDec: allocation.dogTagIdDec,
    dogTagIdField: allocation.dogTagIdFieldDec,
    ownerIdentity: input.ownerIdentity,
    identityLeaves,
    petId,
    petName: input.petName,
    microchip: input.microchip ?? {},
    profile: input.profile,
    status: "pending",
    protocolVersion: "dogtag-v2/1",
    tokenExp,
  });

  const token = generateHexToken();
  await BindToken.create({token, sessionId: session.sessionId, exp: tokenExp, consumed: false});

  const baseUrl = getServerEnv().PUBLIC_BASE_URL ?? new URL(request.url).origin;

  return NextResponse.json(
    {
      token,
      dogTagId: allocation.dogTagIdDec,
      dogTagIdField: allocation.dogTagIdFieldDec,
      sessionId: session.sessionId,
      qr: `${baseUrl.replace(/\/$/, "")}/p/${token}`,
      ttlSecs: TOKEN_TTL_SECS,
    },
    {status: 201},
  );
}
