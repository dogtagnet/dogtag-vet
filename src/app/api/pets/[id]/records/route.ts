import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {roax} from "@/lib/chains";
import {preflightIssuance} from "@/lib/mint/preflight";
import {buildVaccinationRecord, VACCINATION_SCHEMA_ID, VACCINATION_SCHEMA_VERSION} from "@/lib/records/build";
import {createRecordArtifact, listRecordArtifactsForPet} from "@/lib/records/artifact";
import {createRecordArtifactSchema} from "@/lib/schemas/recordIssuance";
import {practitionerDisplayName} from "@/lib/staffRoleTone";
import type {StaffDoc} from "@/lib/models/Staff";
import {badRequest, notFound, requireStaffSession, requireVetSession} from "@/lib/staffApi";

/** Plan section 11.2 V2's context field: the certifying practitioner's composed name + government
 * accreditation number - `practitionerDisplayName` already composes name/title (WP4.13); this adds
 * the accreditation number, distinct from both `issuer.operator` (the wallet) and `issuer.contract`
 * (the clinic's on-chain contract). Derived from the SIGNED-IN vet's OWN staff record only - never
 * client-supplied - so one vet can never attest to being another. */
function composeAuthorizedVet(staff: Pick<StaffDoc, "firstName" | "lastName" | "title" | "displayName" | "email" | "accreditationNumber">): string {
  const name = practitionerDisplayName(staff);
  const accreditation = staff.accreditationNumber?.trim();
  return accreditation ? `${name} (${accreditation})` : name;
}

/** `GET /api/pets/:id/records` - the Records tab's list source (plan section 11.2 V4), newest
 * first. Staff-gated (not vet-gated) like every other read/list route in this app - `POST` below,
 * the actual issuance start, is where the vet-role gate applies. */
export async function GET(_request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id: petId} = await params;
  await connectToDatabase();
  const pet = await Pet.findOne({petId}).lean<PetDoc>();
  if (!pet) return notFound("Pet not found.");

  const records = await listRecordArtifactsForPet(petId);
  return NextResponse.json({records});
}

/**
 * `POST /api/pets/:id/records` - plan section 11.2 V3, step 1: build the leaves + root SERVER-SIDE
 * (no owner-device round trip - a record carries no owner-control leaves to bind) and store a
 * `draft` `RecordArtifact` row. Vet-gated, mirroring `api/tags/issue/start/route.ts`'s own WP4.7A
 * ruling R1 exactly - this is the first step of the SAME issuance flow `tx`/`confirm`/`attestation`
 * already gate.
 *
 * `preflightIssuance` (shared with the tag flow) is run BEFORE anything is built or stored - a
 * misconfigured clinic, an inactive entity, or a non-whitelisted operator wallet never gets even a
 * draft row, mirroring `api/tags/issue/start/route.ts`'s own "preflight before allocating anything".
 */
export async function POST(request: Request, {params}: {params: Promise<{id: string}>}) {
  const {staff, response} = await requireVetSession();
  if (response) return response;

  const {id: petId} = await params;
  const body = await request.json().catch(() => null);
  const parsed = createRecordArtifactSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed record-issuance request.", parsed.error.flatten());
  const input = parsed.data;

  const preflight = await preflightIssuance(input.operatorAddress as `0x${string}`);
  if (!preflight.ok) return badRequest(preflight.message);

  await connectToDatabase();
  const pet = await Pet.findOne({petId}).lean<PetDoc>();
  if (!pet) return notFound("Pet not found.");
  if (!pet.dogTag.dogTagIdField) return badRequest("This pet has no issued DogTag yet - issue a tag before issuing records.");

  const settings = await getClinicSettings();
  const {leaves, root} = buildVaccinationRecord(input.form, {
    dogTagIdField: pet.dogTag.dogTagIdField,
    issuer: {
      chainId: roax.id,
      contract: preflight.cloneAddress,
      operator: input.operatorAddress,
      name: settings.businessProfile?.name,
      domain: settings.businessProfile?.domain,
    },
    authorizedVet: staff ? composeAuthorizedVet(staff) : undefined,
  });

  const created = await createRecordArtifact({
    petId,
    dogTagIdField: pet.dogTag.dogTagIdField,
    recordType: "VACCINATION",
    schemaId: VACCINATION_SCHEMA_ID,
    schemaVersion: VACCINATION_SCHEMA_VERSION,
    protocolVersion: "dogtag-v2/1",
    root,
    leaves,
    chain: {chainId: roax.id, contract: preflight.cloneAddress, operator: input.operatorAddress},
    conformsTo: input.conformsTo,
  });
  if (!created.ok) {
    // Server bug, not a caller input problem - buildVaccinationRecord's own output should always
    // verify (tests/unit/records/build.test.ts proves this end to end); refuse rather than store
    // an artifact this deployment's own verifier does not accept.
    console.error(`record leaf-commitment self-check failed for pet ${petId}: ${created.reason}`);
    return badRequest("Could not build a valid record artifact. Try again.");
  }

  return NextResponse.json({record: created.record}, {status: 201});
}
