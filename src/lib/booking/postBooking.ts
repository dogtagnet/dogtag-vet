import type {Address, Hex} from "viem";
import type {OpenedLeaf} from "@dogtag/standard";
import {clientAlreadyHasWallet} from "@/lib/booking/clientMatch";
import {buildMobileBookingDomain, canonicalPayloadJson, toWireMessage, type MobileBookingMessage} from "@/lib/booking/mobileEip712";
import {computeReceiptHash, type ReceiptRecord} from "@/lib/registration/receipt";
import type {TagClaimResult} from "@/lib/booking/mobileReconcile";
import type {ClientWallet} from "@/lib/models/Client";
import type {PetSex} from "@/lib/models/Pet";

/**
 * The writes `applyPostBookingSideEffects` needs - injected so the decision logic (WHAT to write,
 * and review finding 4's failure trap) is unit-testable with an in-memory fake, the same
 * flow/store-adapter split `resolveTagClaim`'s `MobileTagLookupStore` and `lib/mint/flow.ts`'s
 * `MintFlowStore` already use. The production adapter is `mongoPostBookingStore`
 * (`lib/booking/mobileMongoAdapters.ts`).
 */
export interface PostBookingStore {
  /** The already-imported pet's display name, for the Appointment.petName rebuild (review
   * finding 3) - `null` when the pet vanished between tier resolution and now (the caller falls
   * back rather than failing). */
  findPetName(petId: string): Promise<string | null>;
  addOwnerToPet(petId: string, clientId: string): Promise<void>;
  addPetToClient(clientId: string, petId: string): Promise<void>;
  createExternalPet(input: CreateExternalPetInput): Promise<{petId: string}>;
  /** WP4.9 G3 closure: the tier-4 import's opened leaves are now KEPT, not dropped -
   * `lib/tags/artifact.ts`'s `createTagArtifact` under the hood, `source: "imported"`. Throws (never
   * returns a refusal silently) on anything but `{ok: true}`, so `runSideEffects`'s ordinary
   * await-and-propagate style catches a refusal the exact same way it catches every other failure
   * in this sequence - `applyPostBookingSideEffects`'s outer trap is what turns it into a flagged,
   * non-throwing `postBookingIncomplete` for the caller. */
  createImportedArtifact(input: CreateImportedArtifactInput): Promise<void>;
  /** Links the just-created appointment to the imported/reused pet - `petIds` plus the
   * display-name rebuild in one write. */
  linkAppointmentPet(appointmentId: string, petId: string, petName: string): Promise<void>;
  /** Q1's auto-attach - the same atomic "push unless present" write
   * `appendBookingWalletToClient` provides. */
  appendBookingWallet(clientId: string, entry: ClientWallet): Promise<boolean>;
  /** Review finding 4: marks `bookingIdentity.postBookingIncomplete` so staff can see this
   * booking's follow-up records need review. */
  flagPostBookingIncomplete(appointmentId: string): Promise<void>;
}

export interface CreateExternalPetInput {
  name: string;
  species?: string;
  breed?: string;
  sex?: PetSex;
  dateOfBirth?: string;
  ownerClientId: string;
  dogTag: {
    dogTagIdDec?: string;
    dogTagIdField: string;
    root: string;
    cloneAddress: string;
  };
}

export interface CreateImportedArtifactInput {
  petId: string;
  dogTagIdDec?: string;
  dogTagIdField: string;
  root: string;
  issuerClone: string;
  leaves: OpenedLeaf[];
  reservedLeafHashes: string[];
  now: number;
}

export interface PostBookingWalletInput {
  /** The verified (lowercased) signer - `verifyMobileBookingWalletClaim`'s own output, never the
   * raw wire address. */
  verifiedAddress: string;
  bookingHash: Hex;
  signature: string;
  issuedAt: number;
  deadline: number;
  clinicCloneAddress: Address;
  chainId: number;
}

export interface PostBookingInput {
  appointmentId: string;
  client: {clientId: string; wallets: ClientWallet[]};
  tagClaim: TagClaimResult;
  /** The petName the appointment was created with - the fallback when a reused external pet's
   * record has no usable name of its own. */
  fallbackPetName: string;
  /** The wire's own (unverified) display-name hint - `mobile.pet.name`. */
  wirePetName?: string;
  wireDogTagIdDec?: string;
  /** WP4.9 G3 closure: the SAME opened leaves `resolveTagClaim` already verified against the
   * on-chain root (`tagClaim.dataVerified`) - present only when the wire sent them, i.e. exactly
   * when `tagClaim.tagResolution === "external" && tagClaim.dataVerified` could ever be true. Kept
   * here (never re-derived) so the imported TagArtifact's leaves are byte-identical to what was
   * actually verified, not a second, independently-parsed copy. */
  tagLeaves?: OpenedLeaf[];
  tagReservedLeafHashes?: string[];
  /** Present only when a wallet claim VERIFIED (Q2) - absent means no attach is attempted. */
  wallet?: PostBookingWalletInput;
  /** Server "now", unix seconds - receipt.recoveredAt and the entry's registeredAt. */
  now: number;
}

export type PostBookingOutcome =
  | {completed: true; linkedPet?: {petId: string; petName: string}}
  | {completed: false};

async function runSideEffects(store: PostBookingStore, input: PostBookingInput): Promise<PostBookingOutcome> {
  let linkedPet: {petId: string; petName: string} | undefined;

  const tagClaim = input.tagClaim;
  if (tagClaim.tagResolution === "external" && tagClaim.dataVerified) {
    let importedPetId: string;
    let linkedPetName: string;
    if (tagClaim.existingExternalPetId) {
      importedPetId = tagClaim.existingExternalPetId;
      const [existingName] = await Promise.all([
        store.findPetName(importedPetId),
        store.addOwnerToPet(importedPetId, input.client.clientId),
        store.addPetToClient(input.client.clientId, importedPetId),
      ]);
      linkedPetName = existingName?.trim() || input.fallbackPetName;
    } else {
      const attrs = tagClaim.verifiedAttributes ?? {};
      const importedName = attrs.name?.trim() || input.wirePetName?.trim() || "Pet";
      const created = await store.createExternalPet({
        name: importedName,
        species: attrs.species,
        breed: attrs.breed,
        sex: attrs.sex,
        dateOfBirth: attrs.dateOfBirth,
        ownerClientId: input.client.clientId,
        dogTag: {
          dogTagIdDec: input.wireDogTagIdDec,
          dogTagIdField: tagClaim.dogTagIdField,
          root: tagClaim.root,
          cloneAddress: tagClaim.issuerClone,
        },
      });
      importedPetId = created.petId;
      linkedPetName = importedName;
      await store.addPetToClient(input.client.clientId, importedPetId);
    }

    // WP4.9 G3 closure: keep the leaves this tier already verified, on BOTH paths above (a brand
    // new import and a repeat booking reusing an already-imported pet) - `createImportedArtifact`
    // is idempotent for an already-on-file (petId, root) pair, so calling it unconditionally here
    // is safe and correctly handles the rare case of the SAME pet's tag having been reissued
    // (a new root) at the foreign clinic between bookings.
    if (!input.tagLeaves?.length || !input.tagReservedLeafHashes?.length) {
      throw new Error("tagClaim.dataVerified is true but the wire's leaves/reservedLeafHashes are missing");
    }
    await store.createImportedArtifact({
      petId: importedPetId,
      dogTagIdDec: input.wireDogTagIdDec,
      dogTagIdField: tagClaim.dogTagIdField,
      root: tagClaim.root,
      issuerClone: tagClaim.issuerClone,
      leaves: input.tagLeaves,
      reservedLeafHashes: input.tagReservedLeafHashes,
      now: input.now,
    });

    await store.linkAppointmentPet(input.appointmentId, importedPetId, linkedPetName);
    linkedPet = {petId: importedPetId, petName: linkedPetName};
  }

  if (input.wallet && !clientAlreadyHasWallet(input.client, input.wallet.verifiedAddress)) {
    const domain = buildMobileBookingDomain(input.wallet.chainId, input.wallet.clinicCloneAddress);
    const message: MobileBookingMessage = {
      clinic: input.wallet.clinicCloneAddress,
      bookingHash: input.wallet.bookingHash,
      wallet: input.wallet.verifiedAddress as Address,
      issuedAt: BigInt(input.wallet.issuedAt),
      deadline: BigInt(input.wallet.deadline),
    };
    const receipt: ReceiptRecord = {
      payloadJson: canonicalPayloadJson(domain, toWireMessage(message)),
      signature: input.wallet.signature,
      recoveredAt: input.now,
    };
    await store.appendBookingWallet(input.client.clientId, {
      address: input.wallet.verifiedAddress,
      via: "booking",
      bookingId: input.appointmentId,
      receipt,
      receiptHash: computeReceiptHash(receipt),
      issuedAt: input.wallet.issuedAt,
      registeredAt: input.now,
    });
  }

  return linkedPet ? {completed: true, linkedPet} : {completed: true};
}

/**
 * The post-insert side effects of a mobile booking - Q3's provisional external-pet import/reuse
 * and Q1's wallet auto-attach - extracted from the booking route so review finding 4's contract is
 * enforceable and testable in one place: by the time these run, the appointment itself is DURABLY
 * BOOKED (and, when a wallet claim was involved, its `bookingHash` is burned into the replay
 * guard), so a throw here must never surface as a 500 - the client would retry a booking that
 * actually exists and be told "already used" with nothing to show for it. Any failure is caught,
 * recorded as `bookingIdentity.postBookingIncomplete` (a staff-visible review flag in the
 * provenance box), and folded into `{completed: false}`; the caller always returns the created
 * appointment and its manage token regardless. One trap around the whole sequence, by design: the
 * first failure aborts the remaining side effects too (they may share a cause, e.g. a dropped
 * database connection), and the one flag tells staff to review this booking's follow-up records as
 * a whole. Even the flag write itself failing is swallowed (logged) - the response contract wins.
 */
export async function applyPostBookingSideEffects(store: PostBookingStore, input: PostBookingInput): Promise<PostBookingOutcome> {
  try {
    return await runSideEffects(store, input);
  } catch (err) {
    console.error(`post-booking side effects failed for appointment ${input.appointmentId}:`, err);
    try {
      await store.flagPostBookingIncomplete(input.appointmentId);
    } catch (flagErr) {
      console.error(`could not flag appointment ${input.appointmentId} for post-booking review:`, flagErr);
    }
    return {completed: false};
  }
}
