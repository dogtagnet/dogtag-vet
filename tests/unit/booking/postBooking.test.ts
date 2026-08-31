import {describe, expect, it, vi} from "vitest";
import {applyPostBookingSideEffects, type PostBookingInput, type PostBookingStore} from "@/lib/booking/postBooking";
import {buildMobileBookingDomain, canonicalPayloadJson, toWireMessage} from "@/lib/booking/mobileEip712";
import {computeReceiptHash} from "@/lib/registration/receipt";
import type {TagClaimResult} from "@/lib/booking/mobileReconcile";
import type {ClientWallet} from "@/lib/models/Client";

const CLONE = "0x7b9bf16f0e39adf8c38d8491f4c7e9c17e85d703" as const;
const FOREIGN_CLONE = "0x57f8786264c55cdd8f3ece0ba177f6ad2df90e00";
const A_ROOT = `0x${"11".repeat(32)}`;
const BOOKING_HASH = `0x${"ab".repeat(32)}` as const;
const WALLET = "0x1234567890abcdef1234567890abcdef12345678";

function fakeStore(overrides: Partial<PostBookingStore> = {}): PostBookingStore {
  return {
    findPetName: vi.fn().mockResolvedValue(null),
    addOwnerToPet: vi.fn().mockResolvedValue(undefined),
    addPetToClient: vi.fn().mockResolvedValue(undefined),
    createExternalPet: vi.fn().mockResolvedValue({petId: "pet-new"}),
    linkAppointmentPet: vi.fn().mockResolvedValue(undefined),
    appendBookingWallet: vi.fn().mockResolvedValue(true),
    flagPostBookingIncomplete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const verifiedExternalClaim: TagClaimResult = {
  tagResolution: "external",
  issuerClone: FOREIGN_CLONE,
  dogTagIdField: "12345",
  root: A_ROOT,
  issuerValid: true,
  dataVerificationAttempted: true,
  dataVerified: true,
  verifiedAttributes: {name: "Buddy", species: "dog", breed: "Beagle"},
};

function baseInput(overrides: Partial<PostBookingInput> = {}): PostBookingInput {
  return {
    appointmentId: "appt-1",
    client: {clientId: "client-1", wallets: []},
    tagClaim: {tagResolution: "none"},
    fallbackPetName: "Pet",
    now: 1_700_000_000,
    ...overrides,
  };
}

function walletInput(): PostBookingInput["wallet"] {
  return {
    verifiedAddress: WALLET,
    bookingHash: BOOKING_HASH,
    signature: `0x${"cd".repeat(65)}`,
    issuedAt: 1_699_999_900,
    deadline: 1_700_000_200,
    clinicCloneAddress: CLONE,
    chainId: 135,
  };
}

describe("applyPostBookingSideEffects - Q3 external import", () => {
  it("imports a fresh provisional pet from the verified attributes and links the appointment to it", async () => {
    const store = fakeStore();
    const outcome = await applyPostBookingSideEffects(store, baseInput({tagClaim: verifiedExternalClaim, wireDogTagIdDec: "42"}));

    expect(store.createExternalPet).toHaveBeenCalledWith({
      name: "Buddy",
      species: "dog",
      breed: "Beagle",
      sex: undefined,
      dateOfBirth: undefined,
      ownerClientId: "client-1",
      dogTag: {dogTagIdDec: "42", dogTagIdField: "12345", root: A_ROOT, cloneAddress: FOREIGN_CLONE},
    });
    expect(store.addPetToClient).toHaveBeenCalledWith("client-1", "pet-new");
    expect(store.linkAppointmentPet).toHaveBeenCalledWith("appt-1", "pet-new", "Buddy");
    expect(outcome).toEqual({completed: true, linkedPet: {petId: "pet-new", petName: "Buddy"}});
  });

  it("falls back to the wire name hint, then 'Pet', when the verified attributes carry no name", async () => {
    const store = fakeStore();
    const claim: TagClaimResult = {...verifiedExternalClaim, verifiedAttributes: {species: "dog"}};
    await applyPostBookingSideEffects(store, baseInput({tagClaim: claim, wirePetName: "Rexy"}));
    expect(store.createExternalPet).toHaveBeenCalledWith(expect.objectContaining({name: "Rexy"}));

    const store2 = fakeStore();
    await applyPostBookingSideEffects(store2, baseInput({tagClaim: claim}));
    expect(store2.createExternalPet).toHaveBeenCalledWith(expect.objectContaining({name: "Pet"}));
  });

  it("reuses an already-imported external pet (no create) and rebuilds petName from ITS record (review finding 3)", async () => {
    const store = fakeStore({findPetName: vi.fn().mockResolvedValue("Buddy On File")});
    const claim: TagClaimResult = {...verifiedExternalClaim, existingExternalPetId: "pet-existing"};
    const outcome = await applyPostBookingSideEffects(store, baseInput({tagClaim: claim}));

    expect(store.createExternalPet).not.toHaveBeenCalled();
    expect(store.addOwnerToPet).toHaveBeenCalledWith("pet-existing", "client-1");
    expect(store.addPetToClient).toHaveBeenCalledWith("client-1", "pet-existing");
    expect(store.linkAppointmentPet).toHaveBeenCalledWith("appt-1", "pet-existing", "Buddy On File");
    expect(outcome).toEqual({completed: true, linkedPet: {petId: "pet-existing", petName: "Buddy On File"}});
  });

  it("falls back to the appointment's own petName when the reused pet's record has vanished or has a blank name", async () => {
    const store = fakeStore({findPetName: vi.fn().mockResolvedValue(null)});
    const claim: TagClaimResult = {...verifiedExternalClaim, existingExternalPetId: "pet-existing"};
    await applyPostBookingSideEffects(store, baseInput({tagClaim: claim, fallbackPetName: "Fallback"}));
    expect(store.linkAppointmentPet).toHaveBeenCalledWith("appt-1", "pet-existing", "Fallback");
  });

  it("imports nothing for any claim that is not external+dataVerified", async () => {
    for (const tagClaim of [
      {tagResolution: "none"},
      {tagResolution: "unknown", verificationError: false},
      {...verifiedExternalClaim, dataVerified: false},
    ] as TagClaimResult[]) {
      const store = fakeStore();
      await applyPostBookingSideEffects(store, baseInput({tagClaim}));
      expect(store.createExternalPet).not.toHaveBeenCalled();
      expect(store.linkAppointmentPet).not.toHaveBeenCalled();
    }
  });
});

describe("applyPostBookingSideEffects - Q1 wallet auto-attach", () => {
  it("appends a via:'booking' entry whose receipt round-trips through the production canonical encoding", async () => {
    const store = fakeStore();
    const input = baseInput({wallet: walletInput()});
    await applyPostBookingSideEffects(store, input);

    expect(store.appendBookingWallet).toHaveBeenCalledTimes(1);
    const [clientId, entry] = (store.appendBookingWallet as ReturnType<typeof vi.fn>).mock.calls[0] as [string, ClientWallet];
    expect(clientId).toBe("client-1");
    expect(entry.address).toBe(WALLET);
    expect(entry.via).toBe("booking");
    expect(entry.bookingId).toBe("appt-1");
    expect(entry.issuedAt).toBe(1_699_999_900);
    expect(entry.registeredAt).toBe(1_700_000_000);
    expect(entry.receipt.recoveredAt).toBe(1_700_000_000);

    const domain = buildMobileBookingDomain(135, CLONE);
    const expectedPayload = canonicalPayloadJson(
      domain,
      toWireMessage({clinic: CLONE, bookingHash: BOOKING_HASH, wallet: WALLET as `0x${string}`, issuedAt: 1_699_999_900n, deadline: 1_700_000_200n}),
    );
    expect(entry.receipt.payloadJson).toBe(expectedPayload);
    expect(entry.receiptHash).toBe(computeReceiptHash(entry.receipt));
  });

  it("does not attach when the client already carries this wallet (any case, active or revoked)", async () => {
    const store = fakeStore();
    const client = {
      clientId: "client-1",
      wallets: [{address: WALLET.toUpperCase()} as unknown as ClientWallet],
    };
    await applyPostBookingSideEffects(store, baseInput({wallet: walletInput(), client}));
    expect(store.appendBookingWallet).not.toHaveBeenCalled();
  });

  it("does not attach when no wallet claim verified", async () => {
    const store = fakeStore();
    await applyPostBookingSideEffects(store, baseInput());
    expect(store.appendBookingWallet).not.toHaveBeenCalled();
  });
});

describe("applyPostBookingSideEffects - review finding 4's failure trap", () => {
  it("never throws when the external import fails mid-way: flags the appointment and reports completed:false", async () => {
    const store = fakeStore({createExternalPet: vi.fn().mockRejectedValue(new Error("transient mongo failure"))});
    const outcome = await applyPostBookingSideEffects(store, baseInput({tagClaim: verifiedExternalClaim, wallet: walletInput()}));

    expect(outcome).toEqual({completed: false});
    expect(store.flagPostBookingIncomplete).toHaveBeenCalledWith("appt-1");
    // One trap around the whole sequence: the first failure aborts the remaining side effects
    // (they may share a cause), and the single flag covers reviewing all of them.
    expect(store.appendBookingWallet).not.toHaveBeenCalled();
  });

  it("never throws when the wallet attach fails: flags the appointment and reports completed:false", async () => {
    const store = fakeStore({appendBookingWallet: vi.fn().mockRejectedValue(new Error("transient mongo failure"))});
    const outcome = await applyPostBookingSideEffects(store, baseInput({wallet: walletInput()}));

    expect(outcome).toEqual({completed: false});
    expect(store.flagPostBookingIncomplete).toHaveBeenCalledWith("appt-1");
  });

  it("never throws when the appointment-link write fails after the pet import", async () => {
    const store = fakeStore({linkAppointmentPet: vi.fn().mockRejectedValue(new Error("transient mongo failure"))});
    const outcome = await applyPostBookingSideEffects(store, baseInput({tagClaim: verifiedExternalClaim}));
    expect(outcome).toEqual({completed: false});
    expect(store.flagPostBookingIncomplete).toHaveBeenCalledWith("appt-1");
  });

  it("still resolves completed:false when even the review-flag write fails - the 201 response contract wins", async () => {
    const store = fakeStore({
      createExternalPet: vi.fn().mockRejectedValue(new Error("transient mongo failure")),
      flagPostBookingIncomplete: vi.fn().mockRejectedValue(new Error("flag write failed too")),
    });
    await expect(applyPostBookingSideEffects(store, baseInput({tagClaim: verifiedExternalClaim}))).resolves.toEqual({completed: false});
  });
});
