import {describe, expect, it} from "vitest";
import {deriveAppointmentDisplayNames, isTaggingConsistent, petsBelongToClient} from "@/lib/booking/appointmentTagging";

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
