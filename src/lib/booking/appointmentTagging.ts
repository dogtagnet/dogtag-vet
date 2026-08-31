import "server-only";
import {Client} from "@/lib/models/Client";
import {Pet, type PetDoc} from "@/lib/models/Pet";

/**
 * WP4.3 A1/C5: does every one of `petIds` belong to `clientId` - i.e. is `clientId` present in
 * that pet's `ownerClientIds`? `ownerClientIdsByPetId` is the caller's already-fetched lookup (a
 * petId missing from it - a pet that does not exist, or was never fetched - counts as "does not
 * belong", the same as an explicit owner mismatch). A pet can have MULTIPLE owners
 * (`Pet.ownerClientIds` is many-to-many, wp4-vet.md's Data model): this checks membership, not
 * exclusivity, so a shared pet still passes for every one of its owners.
 */
export function petsBelongToClient(
  clientId: string,
  petIds: string[],
  ownerClientIdsByPetId: Record<string, string[] | undefined>,
): boolean {
  return petIds.every((petId) => (ownerClientIdsByPetId[petId] ?? []).includes(clientId));
}

/**
 * WP4.3's tagging model is one client, N pets, together or not at all: a tagged appointment
 * (`clientId` set) always has at least one pet, and pets never dangle on an appointment with no
 * tagged client. `petIds.length > 0` and `Boolean(clientId)` must therefore always agree - this is
 * the single cardinality check both the create schemas' `superRefine` and the PATCH route's
 * resolver enforce, applied uniformly rather than as two different asymmetric rules.
 */
export function isTaggingConsistent(clientId: string | undefined, petIds: string[]): boolean {
  return Boolean(clientId) === (petIds.length > 0);
}

/** Tri-state description of what one PATCH (or create) call changes about EITHER denormalized
 * display string - mirrors the tri-state `clientId`/`petIds` themselves carry:
 * `undefined` = this side of the tag is not part of this change at all (leave the current display
 *   string exactly as it is - e.g. a request that only changes `notes` or `status`).
 * `null` = this side of the tag was explicitly cleared (untagged) - freeze the current display
 *   string rather than blanking it (see `deriveAppointmentDisplayNames`'s doc comment for why).
 * a `string` = the newly resolved display text (the live client's name, or the newly-tagged pets'
 *   names already joined) - the caller has already looked this up. */
export interface AppointmentNameChange {
  clientName?: string | null;
  petName?: string | null;
}

/**
 * Rebuilds the denormalized `clientName`/`petName` strings an appointment carries - the one place
 * every tag-mutating call site (staff create, from-local-time create, PATCH retag/untag) goes
 * through, so the list/calendar/search surfaces that read these two strings directly never drift
 * from the linked Client/Pet records (WP4.3 A1, normative).
 *
 * Untagging freezes the current display string instead of blanking it: `clientName`/`petName` are
 * required, non-blank fields end to end (zod + mongoose), and the PATCH surface this app exposes
 * (`{status?, clientId? nullable, petIds?, notes?}`, WP4.3 C6) has no slot for new free text on an
 * untag - there is nothing else this could correctly produce. The practical effect is that a
 * once-tagged, now-untagged appointment keeps showing its last-known client/pet names as plain
 * text (never as a link - every "is this tagged?" render decision keys off `clientId`/`petIds`
 * presence, never off `clientName`/`petName` truthiness) rather than going blank.
 */
export function deriveAppointmentDisplayNames(
  current: {clientName: string; petName: string},
  change: AppointmentNameChange,
): {clientName: string; petName: string} {
  return {
    clientName: change.clientName === undefined || change.clientName === null ? current.clientName : change.clientName,
    petName: change.petName === undefined || change.petName === null ? current.petName : change.petName,
  };
}

export type TaggingErrorCode = "client_not_found" | "pet_not_found" | "pet_not_owned" | "tagging_mismatch";

export interface TaggingError {
  code: TaggingErrorCode;
  message: string;
}

/** Tri-state input describing what a create or PATCH call wants to change about the tag -
 * `undefined` leaves that side untouched, matching `AppointmentNameChange`'s own tri-state. */
export interface TaggingChangeInput {
  clientId?: string | null;
  petIds?: string[];
}

export interface ResolvedTagging {
  /** Present only when `change.clientId` was a string (tag/retag) - the caller `$set`s it. */
  setClientId?: string;
  /** Present only when `change.clientId` was `null` (untag) - the caller `$unset`s it. */
  unsetClientId?: true;
  /** Present only when `change.petIds` was provided at all - the caller `$set`s it (an empty
   * array is a legitimate value here, distinct from "not provided"). */
  setPetIds?: string[];
  clientName: string;
  petName: string;
}

/**
 * Resolves ONE tagging change - a create, or a PATCH retag/untag - against the live Client/Pet
 * collections: looks up whatever this change touches, enforces `isTaggingConsistent` against the
 * RESULTING {clientId, petIds} pair (the new value if this change touches that side, else whatever
 * the appointment already had), validates `petsBelongToClient` for the resulting pair whenever
 * either side of the tag changed (a retag that does not re-mention `petIds` must not silently keep
 * pointing at the PREVIOUS client's pets), and returns exactly the fields to persist - including
 * the rebuilt `clientName`/`petName` via `deriveAppointmentDisplayNames`. The caller still owns the
 * actual write (`Appointment.create` vs `findOneAndUpdate`), since that differs by call site.
 *
 * Both checks below are gated on `tagSideChanging` - the invariant is a rule on the TAGGING
 * OPERATION, not a document-level precondition every call must satisfy regardless of what it
 * touches (WP4.3 round-1 fix). Public booking (`clientMatch.ts`) links a real client but never a
 * pet - `clientId` set, `petIds` empty - and that shape is permanently frozen (spec Facts line 9,
 * C10 "public booking flow is UNCHANGED"). Re-checking that untouched, pre-existing shape on every
 * PATCH - including one that only changes `status` or `notes` - made every public-booking
 * appointment permanently un-PATCHable (capacity buckets could never be released on cancel). A
 * request that actually retags (mentions `clientId` and/or `petIds`) still must leave the
 * RESULTING pair consistent, same as before.
 *
 * Partially unit-tested (the two gates above, since a request that changes neither side never
 * touches Mongo at all - see `resolveTagging`'s tests in `appointmentTagging.test.ts`); the
 * DB-touching branches remain covered by the Playwright e2e journey instead.
 */
export async function resolveTagging(
  current: {clientId?: string; petIds: string[]; clientName: string; petName: string},
  change: TaggingChangeInput,
): Promise<{ok: true; result: ResolvedTagging} | {ok: false; error: TaggingError}> {
  const resultingClientId = change.clientId === undefined ? current.clientId : (change.clientId ?? undefined);
  const effectivePetIds = change.petIds === undefined ? current.petIds : change.petIds;
  const tagSideChanging = change.clientId !== undefined || change.petIds !== undefined;

  if (tagSideChanging && !isTaggingConsistent(resultingClientId, effectivePetIds)) {
    return {
      ok: false,
      error: resultingClientId
        ? {code: "tagging_mismatch", message: "At least one pet is required when tagging a client."}
        : {code: "tagging_mismatch", message: "Pets can only be tagged when a client is also tagged."},
    };
  }

  // Either side of the tag changing must re-validate ownership of the RESULTING pair, even if this
  // particular request only mentioned one side - see the doc comment above.
  if (tagSideChanging && effectivePetIds.length > 0 && resultingClientId) {
    const pets = await Pet.find({petId: {$in: effectivePetIds}}).lean<Pick<PetDoc, "petId" | "ownerClientIds">[]>();
    if (pets.length !== effectivePetIds.length) {
      return {ok: false, error: {code: "pet_not_found", message: "One or more selected pets were not found."}};
    }
    const ownerClientIdsByPetId = Object.fromEntries(pets.map((p) => [p.petId, p.ownerClientIds]));
    if (!petsBelongToClient(resultingClientId, effectivePetIds, ownerClientIdsByPetId)) {
      return {
        ok: false,
        error: {code: "pet_not_owned", message: "One or more selected pets do not belong to this client."},
      };
    }
  }

  let resolvedClientName: string | null | undefined;
  let setClientId: string | undefined;
  let unsetClientId: true | undefined;
  if (change.clientId === undefined) {
    resolvedClientName = undefined;
  } else if (change.clientId === null) {
    resolvedClientName = null;
    unsetClientId = true;
  } else {
    const client = await Client.findOne({clientId: change.clientId}).lean<{name: string} | null>();
    if (!client) return {ok: false, error: {code: "client_not_found", message: "Selected client was not found."}};
    resolvedClientName = client.name;
    setClientId = change.clientId;
  }

  let resolvedPetName: string | null | undefined;
  let setPetIds: string[] | undefined;
  if (change.petIds === undefined) {
    resolvedPetName = undefined;
  } else if (change.petIds.length === 0) {
    resolvedPetName = null;
    setPetIds = [];
  } else {
    // Ownership of these exact ids against the resulting client was already validated above
    // (tagSideChanging is true whenever change.petIds is defined) - just fetch names to join here.
    const pets = await Pet.find({petId: {$in: change.petIds}}).lean<Pick<PetDoc, "petId" | "name">[]>();
    const nameByPetId = Object.fromEntries(pets.map((p) => [p.petId, p.name]));
    resolvedPetName = change.petIds.map((petId) => nameByPetId[petId]).join(", ");
    setPetIds = change.petIds;
  }

  const {clientName, petName} = deriveAppointmentDisplayNames(current, {
    clientName: resolvedClientName,
    petName: resolvedPetName,
  });

  return {ok: true, result: {setClientId, unsetClientId, setPetIds, clientName, petName}};
}
