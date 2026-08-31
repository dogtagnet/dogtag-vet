import {describe, expect, it} from "vitest";
import {
  deriveAppointmentDisplayNames,
  isTaggingConsistent,
  orderPetsByPetIds,
  petsBelongToClient,
  resolveTagging,
} from "@/lib/booking/appointmentTagging";

describe("petsBelongToClient", () => {
  it("is true when every petId's owner set includes clientId", () => {
    const ownerClientIdsByPetId = {p1: ["client-a"], p2: ["client-a", "client-b"]};
    expect(petsBelongToClient("client-a", ["p1", "p2"], ownerClientIdsByPetId)).toBe(true);
  });

  it("is false when a petId's owner set does not include clientId", () => {
    const ownerClientIdsByPetId = {p1: ["client-a"], p2: ["client-b"]};
    expect(petsBelongToClient("client-a", ["p1", "p2"], ownerClientIdsByPetId)).toBe(false);
  });

  it("is true for a pet with MULTIPLE owners, as long as the given clientId is one of them", () => {
    // WP4.3 E's explicit case: a pet can have more than one owner (Pet.ownerClientIds is
    // many-to-many) - membership, not exclusivity, is what this checks.
    const ownerClientIdsByPetId = {shared: ["client-a", "client-b", "client-c"]};
    expect(petsBelongToClient("client-b", ["shared"], ownerClientIdsByPetId)).toBe(true);
  });

  it("is false when a petId is missing from the map entirely (pet not found)", () => {
    expect(petsBelongToClient("client-a", ["ghost"], {})).toBe(false);
  });

  it("is trivially true for an empty petIds list", () => {
    expect(petsBelongToClient("client-a", [], {})).toBe(true);
  });
});

describe("isTaggingConsistent", () => {
  it("is true when neither a client nor any pets are tagged", () => {
    expect(isTaggingConsistent(undefined, [])).toBe(true);
  });

  it("is true when a client and at least one pet are both tagged", () => {
    expect(isTaggingConsistent("client-a", ["p1"])).toBe(true);
  });

  it("is false when a client is tagged but zero pets are - a tagged appointment always needs at least one pet", () => {
    expect(isTaggingConsistent("client-a", [])).toBe(false);
  });

  it("is false when pets are tagged but no client is - pets cannot dangle without an owning client on the appointment", () => {
    expect(isTaggingConsistent(undefined, ["p1"])).toBe(false);
  });
});

describe("deriveAppointmentDisplayNames", () => {
  const current = {clientName: "Old Client", petName: "Old Pet"};

  it("leaves both names untouched when neither field is part of this change", () => {
    // e.g. a PATCH that only changes notes/status.
    expect(deriveAppointmentDisplayNames(current, {})).toEqual(current);
  });

  it("tags: replaces both names with the newly resolved strings", () => {
    const result = deriveAppointmentDisplayNames(current, {clientName: "Jane Doe", petName: "Rex, Fido"});
    expect(result).toEqual({clientName: "Jane Doe", petName: "Rex, Fido"});
  });

  it("retags: replaces again with a different resolved string", () => {
    const tagged = deriveAppointmentDisplayNames(current, {clientName: "Jane Doe", petName: "Rex"});
    const retagged = deriveAppointmentDisplayNames(tagged, {clientName: "John Smith", petName: "Milo"});
    expect(retagged).toEqual({clientName: "John Smith", petName: "Milo"});
  });

  it("untags (clientName/petName: null): freezes the previous display strings rather than blanking them", () => {
    // Forced by the PATCH contract (WP4.3 C6): {status?, clientId? nullable, petIds?, notes?} has
    // no slot for new free text on untag, so there is nothing else this could correctly do -
    // clientName/petName stay required non-blank end to end (schema + mongoose).
    const result = deriveAppointmentDisplayNames(current, {clientName: null, petName: null});
    expect(result).toEqual(current);
  });

  it("changes only the client side when only clientName is part of the change", () => {
    const result = deriveAppointmentDisplayNames(current, {clientName: "Jane Doe"});
    expect(result).toEqual({clientName: "Jane Doe", petName: "Old Pet"});
  });

  it("changes only the pet side when only petName is part of the change", () => {
    const result = deriveAppointmentDisplayNames(current, {petName: "Rex, Fido"});
    expect(result).toEqual({clientName: "Old Client", petName: "Rex, Fido"});
  });
});

describe("resolveTagging - the symmetric invariant is a rule on the TAGGING OPERATION, not a document-level precondition", () => {
  // Round-1 regression (WP4.3 grading): public booking (clientMatch.ts) links a real client but
  // never a pet - clientId set, petIds empty - and that shape is explicitly frozen (spec Facts
  // line 9, C10 "public booking flow is UNCHANGED"). A PATCH that does not mention clientId or
  // petIds at all (e.g. {status: "cancelled"} or {notes: "..."}) must not re-validate that
  // untouched, pre-existing shape against the invariant - doing so made every public-booking
  // appointment permanently un-PATCHable (capacity buckets could never be released on cancel).
  const publicBookingShape = {clientId: "client-real", petIds: [], clientName: "Jane Doe", petName: "Regression Pet"};

  it("leaves an already-inconsistent shape alone when the request touches neither clientId nor petIds", async () => {
    const result = await resolveTagging(publicBookingShape, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Neither side of the tag was part of this change, so nothing about it should be written.
    expect(result.result.setClientId).toBeUndefined();
    expect(result.result.unsetClientId).toBeUndefined();
    expect(result.result.setPetIds).toBeUndefined();
    // And the display strings pass through untouched (this request wasn't a retag).
    expect(result.result.clientName).toBe("Jane Doe");
    expect(result.result.petName).toBe("Regression Pet");
  });

  it("still refuses a request that DOES touch the tag and would leave the resulting pair inconsistent, even starting from an already-inconsistent shape", async () => {
    // Retagging to a new client without also sending petIds must not silently inherit the OLD
    // (empty) petIds and call that consistent - the invariant still applies to the RESULTING pair
    // whenever the tag itself is part of the change. This never reaches Client.findOne/Pet.find:
    // the resulting pair (clientId truthy, petIds empty) fails isTaggingConsistent first.
    const result = await resolveTagging(publicBookingShape, {clientId: "some-other-client"});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("tagging_mismatch");
  });

  it("still refuses clearing petIds alone (without also nulling clientId) against an already-tagged appointment", async () => {
    const tagged = {clientId: "client-a", petIds: ["p1"], clientName: "Jane Doe", petName: "Rex"};
    const result = await resolveTagging(tagged, {petIds: []});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("tagging_mismatch");
  });

  it("a status/notes-only change (petIds provided as untouched-equivalent via undefined) resolves fine even from a consistent shape", async () => {
    const consistent = {clientId: "client-a", petIds: ["p1"], clientName: "Jane Doe", petName: "Rex"};
    const result = await resolveTagging(consistent, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.clientName).toBe("Jane Doe");
    expect(result.result.petName).toBe("Rex");
  });
});

describe("orderPetsByPetIds", () => {
  // Round-1 regression (WP4.3 grading): the appointment detail page fetches tagged pets with
  // `Pet.find({petId: {$in: petIds}})`, which does NOT preserve `petIds`' order - Mongo returns
  // matches in natural/index order. That left the PageHeader subtitle (built from the stored
  // `petName`, itself joined in `petIds` order by resolveTagging) showing a different pet order
  // than the "Tagged to" pets list and the Edit-tagging chips on the very same page - and because
  // EditTaggingSection seeds its selection from that same reordered array, saving "Edit tagging"
  // with zero actual edits silently rewrote the stored petName into the wrong order.
  const zulu = {petId: "zulu", name: "Zulu"};
  const alpha = {petId: "alpha", name: "Alpha"};
  const mike = {petId: "mike", name: "Mike"};

  it("reorders fetched docs to match petIds order, regardless of the order they were fetched in", () => {
    // Simulates Mongo's natural/index order (alphabetical by petId here) differing from the
    // appointment's actual stored petIds order (Zulu, Alpha, Mike).
    const fetchedInNaturalOrder = [alpha, mike, zulu];
    expect(orderPetsByPetIds(fetchedInNaturalOrder, ["zulu", "alpha", "mike"])).toEqual([zulu, alpha, mike]);
  });

  it("is a no-op when the fetch already happens to match petIds order", () => {
    expect(orderPetsByPetIds([alpha, mike, zulu], ["alpha", "mike", "zulu"])).toEqual([alpha, mike, zulu]);
  });

  it("drops a petId with no matching fetched document instead of emitting undefined", () => {
    // Defensive, matching the rest of this file's "petIds ?? []" tolerance for a pet that no
    // longer resolves (e.g. deleted after being tagged) - never surfaces a hole in the list.
    expect(orderPetsByPetIds([alpha], ["alpha", "ghost"])).toEqual([alpha]);
  });

  it("returns an empty array for an empty petIds list", () => {
    expect(orderPetsByPetIds([alpha, mike], [])).toEqual([]);
  });
});
