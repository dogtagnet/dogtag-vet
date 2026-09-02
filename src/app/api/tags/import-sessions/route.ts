import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {ArtifactImportSession} from "@/lib/models/ArtifactImportSession";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {generateHexToken} from "@/lib/models/BindToken";
import {getServerEnv} from "@/lib/env";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";

/** How long a generated import QR stays valid - plan 2.3's `now+600s`, same TTL as export. */
const IMPORT_TTL_SECS = 600;

/**
 * `POST /api/tags/import-sessions {targetPetId?}` - plans/wp4.9-tag-data-custody.md section 2.3.
 * Staff-only. One route serves BOTH UI entry points (the Tags page's standalone "Import tag" and
 * the pet page's variant): the pet-page caller always supplies its own `petId` as `targetPetId`,
 * the Tags-page caller supplies one only when staff picked an existing target, or omits it
 * entirely for "create new pet from verified data" - there is no behavioral difference between the
 * two call sites beyond which UI supplied `targetPetId`, so a second, near-duplicate route would
 * add nothing (unlike export, which the checklist scopes under `/api/pets/:id/...` because it is
 * ALWAYS tied to one already-known pet).
 *
 * Snapshots `clinicName`/`cloneAddress` at creation (never re-read live at resolve/complete time) -
 * the same convention `WalletRegistrationSession` already established, and load-bearing here
 * specifically for `cloneAddress`: `completeImport`'s "reclaim" check compares the issuer clone
 * read from chain against THIS snapshot, so an unset clone address would make every import
 * silently look external even when it is this clinic's own reissued tag.
 */
export async function POST(request: Request) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const body = (await request.json().catch(() => ({}))) as {targetPetId?: unknown};
  const targetPetId = typeof body.targetPetId === "string" && body.targetPetId.length > 0 ? body.targetPetId : undefined;

  await connectToDatabase();

  if (targetPetId) {
    const pet = await Pet.findOne({petId: targetPetId}).lean<PetDoc>();
    if (!pet) return notFound("Pet not found.");
    if (pet.dogTag?.status === "active" && pet.dogTag.dogTagIdDec) {
      return badRequest("This pet already has an active tag. Revoke or replace it first, or import onto a different pet.");
    }
  }

  const settings = await getClinicSettings();
  if (!settings.cloneAddress) {
    return badRequest("This clinic has not completed setup. Discover and save your clone first.");
  }
  const clinicName = settings.businessProfile?.name?.trim();
  if (!clinicName) {
    return badRequest("Set this clinic's name in Settings before importing tag data - the owner needs to see who they're sending it to.");
  }

  const now = Math.floor(Date.now() / 1000);
  const token = generateHexToken();
  const exp = now + IMPORT_TTL_SECS;

  await ArtifactImportSession.create({
    token,
    targetPetId,
    clinicName,
    cloneAddress: settings.cloneAddress.toLowerCase(),
    exp,
  });

  const baseUrl = getServerEnv().PUBLIC_BASE_URL ?? new URL(request.url).origin;
  const qr = `${baseUrl.replace(/\/$/, "")}/i/${token}`;

  return NextResponse.json({token, qr, ttlSecs: IMPORT_TTL_SECS, issuedAt: now}, {status: 201});
}
