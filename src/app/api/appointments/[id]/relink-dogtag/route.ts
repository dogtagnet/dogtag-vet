import {NextResponse} from "next/server";
import type {Address} from "viem";
import {dogTagIdField} from "@dogtag/standard";
import {readProfileRoot, readRootIssuer} from "@/lib/chainRead";
import {linkPetDogTag} from "@/lib/mint/reconcile";
import {connectToDatabase} from "@/lib/db";
import {getServerEnv} from "@/lib/env";
import {Appointment, type AppointmentDoc} from "@/lib/models/Appointment";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {Client} from "@/lib/models/Client";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {relinkDogTagSchema} from "@/lib/schemas/appointment";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";

const ZERO_HEX32 = `0x${"0".repeat(64)}`;

/**
 * `POST /api/appointments/:id/relink-dogtag` - WP4.4 tier 3's staff action:
 * `bookingIdentity.tagResolution === "issued_here_unlinked"` means a tag THIS clinic issued exists
 * on chain, but no local `Pet` record carries the link (typically after a database restore) -
 * staff picks which pet it actually belongs to.
 *
 * Re-verifies on chain before writing anything, rather than trusting the `bookingIdentity` snapshot
 * taken at booking time: `readProfileRoot`/`readRootIssuer` are re-read fresh, and the write only
 * proceeds if the root is still set and still resolves to THIS clinic's clone - the same
 * fail-closed "a receipt is not proof" doctrine every other chain-anchored write in this app
 * follows. The actual seal is `lib/mint/reconcile.ts`'s `linkPetDogTag` - the SAME write the mint
 * confirm route uses, not a second copy of it.
 */
export async function POST(request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id} = await params;
  const body = await request.json().catch(() => null);
  const parsed = relinkDogTagSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed relink request.", parsed.error.flatten());

  await connectToDatabase();
  const appointment = await Appointment.findOne({appointmentId: id}).lean<AppointmentDoc>();
  if (!appointment) return notFound("Appointment not found.");

  const bookingIdentity = appointment.bookingIdentity;
  if (!bookingIdentity || bookingIdentity.tagResolution !== "issued_here_unlinked" || !bookingIdentity.dogTagIdDec) {
    return badRequest("This appointment has no unlinked tag claim to relink.");
  }

  const settings = await getClinicSettings();
  if (!settings.cloneAddress) return badRequest("This clinic has not completed setup.");

  const env = getServerEnv();
  if (!env.DOGTAG_SBT_ADDRESS || !env.VET_ISSUER_FACTORY_ADDRESS) {
    return badRequest("This clinic has not configured its protocol contract addresses.");
  }

  let dogTagIdFieldDec: string;
  try {
    dogTagIdFieldDec = dogTagIdField(bookingIdentity.dogTagIdDec).toString(10);
  } catch {
    return badRequest("Malformed tag id.");
  }

  let root: string;
  let issuer: string;
  try {
    root = await readProfileRoot(env.DOGTAG_SBT_ADDRESS as Address, dogTagIdFieldDec);
    if (root.toLowerCase() === ZERO_HEX32) {
      return badRequest("This tag is no longer found on chain - it may have been reset since this booking was made.");
    }
    issuer = await readRootIssuer(env.VET_ISSUER_FACTORY_ADDRESS as Address, root);
  } catch {
    return NextResponse.json(
      {error: {code: "chain_unreachable", message: "Could not reach the chain to re-verify this tag. Try again shortly."}},
      {status: 503},
    );
  }
  if (issuer.toLowerCase() !== settings.cloneAddress.toLowerCase()) {
    return badRequest("This tag is no longer issued by this clinic's clone.");
  }

  const pet = await Pet.findOne({petId: parsed.data.petId}).lean<PetDoc>();
  if (!pet) return notFound("Pet not found.");

  // Review finding 2 (duplicate guard): one physical tag maps to at most ONE local pet record -
  // `resolveTagClaim`'s tier-1 lookup is a findOne over `dogTag.dogTagIdDec`/`dogTagIdField`, so
  // a second pet carrying the same tag would make every future resolution of this tag
  // nondeterministic. Relinking onto the SAME pet again (petId equal) is resolution, not
  // duplication - e.g. a second appointment carrying the same claim being pointed at the pet that
  // already holds the tag - and stays allowed; only a DIFFERENT pet already holding this tag
  // rejects. Checked before any write, per the validate-everything-before-any-write idiom this
  // route already follows.
  const conflicting = await Pet.findOne({
    petId: {$ne: pet.petId},
    $or: [{"dogTag.dogTagIdField": dogTagIdFieldDec}, {"dogTag.dogTagIdDec": bookingIdentity.dogTagIdDec}],
  }).lean<Pick<PetDoc, "petId" | "name">>();
  if (conflicting) {
    return badRequest(`This tag is already linked to another pet record ("${conflicting.name}") - a tag can only belong to one pet.`);
  }

  await linkPetDogTag(pet.petId, {
    dogTagIdDec: bookingIdentity.dogTagIdDec,
    dogTagIdField: dogTagIdFieldDec,
    root,
    cloneAddress: settings.cloneAddress,
  });

  // Ties the appointment - and, when it has one, its resolved client - to the now-relinked pet:
  // the practical point of relinking from this appointment's own provenance box in the first
  // place, not just sealing the chain data in isolation. Review finding 2: the provenance
  // resolution flips to "local" in the same write - the tag now genuinely matches a pet on file
  // (a fresh resolveTagClaim would say exactly that), so the "issued here but not linked" banner
  // and its Relink control retire instead of staying live and offering to write the same tag onto
  // a second pet.
  await Appointment.updateOne(
    {appointmentId: id},
    {$set: {petIds: [pet.petId], petName: pet.name, "bookingIdentity.tagResolution": "local"}},
  );
  if (appointment.clientId) {
    await Promise.all([
      Pet.updateOne({petId: pet.petId}, {$addToSet: {ownerClientIds: appointment.clientId}}),
      Client.updateOne({clientId: appointment.clientId}, {$addToSet: {petIds: pet.petId}}),
    ]);
  }

  const updated = await Appointment.findOne({appointmentId: id}).lean<AppointmentDoc>();
  return NextResponse.json(updated);
}
