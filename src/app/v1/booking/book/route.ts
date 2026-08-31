import {randomBytes} from "node:crypto";
import type {Address, Hex} from "viem";
import {createAppointment} from "@/lib/booking/lifecycle";
import {loadAvailabilityConfig} from "@/lib/booking/queries";
import {appendBookingWalletToClient, clientAlreadyHasWallet, findOrCreateClientForBooking, findOrCreateClientForMobileBooking} from "@/lib/booking/clientMatch";
import {sendBookingConfirmation} from "@/lib/booking/confirmation";
import {toPublicAppointmentStatus} from "@/lib/booking/status";
import {computeMobileBookingHash} from "@/lib/booking/bookingHash";
import {buildMobileBookingDomain, canonicalPayloadJson, toWireMessage, type MobileBookingMessage} from "@/lib/booking/mobileEip712";
import {verifyMobileBookingWalletClaim, type MobileBookingWalletClaimInvalidReason} from "@/lib/booking/walletClaim";
import {mongoMobileTagChainDeps, mongoMobileTagLookupStore, unconfiguredMobileTagChainDeps} from "@/lib/booking/mobileMongoAdapters";
import {resolveTagClaim, toBookingIdentity, type TagClaimResult} from "@/lib/booking/mobileReconcile";
import {connectToDatabase} from "@/lib/db";
import {roax} from "@/lib/chains";
import {getServerEnv} from "@/lib/env";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {computeReceiptHash, type ReceiptRecord} from "@/lib/registration/receipt";
import type {AppointmentDraft} from "@/lib/booking/mongoStore";
import {Appointment, type BookingIdentity} from "@/lib/models/Appointment";
import {Client} from "@/lib/models/Client";
import {Pet, buildPetSearchKey} from "@/lib/models/Pet";
import {Service, type ServiceDoc} from "@/lib/models/Service";
import {bookAppointmentRequestSchema} from "@/lib/schemas/booking";
import {enforceRateLimit, errorBody, jsonWithHeaders, readJsonBody} from "@/lib/publicApi";

/** A device-safe sentence per `VerifyMobileBookingWalletClaimResult`'s reason - Q2: "an invalid
 * signature REJECTS the whole booking with a correct, specific error message." */
function walletClaimErrorMessage(reason: MobileBookingWalletClaimInvalidReason): string {
  switch (reason) {
    case "signature_invalid":
      return "This booking's wallet signature is not valid.";
    case "expired":
      return "This booking's wallet signature has expired. Please try booking again.";
    case "window_too_long":
      return "This booking's wallet signature window is too long.";
    case "issued_in_future":
      return "This booking's wallet signature was issued in the future.";
    case "deadline_before_issued_at":
      return "This booking's wallet signature has an invalid time window.";
  }
}

/**
 * `POST /v1/booking/book` - `vet-public-api.yaml`. This build has no staff-approval step: a
 * successful booking is confirmed immediately (email + ics sent right away), so the response
 * status is always `confirmed` (see `toPublicAppointmentStatus`'s doc comment) and `ics` is
 * always present.
 *
 * WP4.4 v2 (plans/wp4.4-mobile-booking-protocol.md, normative). The optional `mobile` block adds,
 * in order:
 * 1. A signed wallet claim (section 2) - verified BEFORE anything else the mobile block touches:
 *    an invalid signature rejects the WHOLE booking (Q2), so nothing downstream (client
 *    resolution, tag-claim tiers, the appointment itself) should ever be reached on that path.
 * 2. Client resolution (section 3): wallet-match-first when a claim verified, else today's
 *    email/phone match-or-create, unchanged.
 * 3. Tag-claim tier resolution (section 3, tiers 1-4) - pure reads, zero writes; done BEFORE
 *    `createAppointment` so its result can go straight into the insert draft for the one tier that
 *    needs to (tier 1's clean local match - `petIds` at create time, no follow-up write).
 * 4. Two writes that need the just-created appointmentId and so happen AFTER `createAppointment`
 *    succeeds, never before: Q3's provisional external-pet import/reuse (avoids leaving an
 *    orphaned Pet document behind if the booking itself then loses a slot-capacity race), and Q1's
 *    wallet auto-attach (`ClientWallet.bookingId` names the appointment that attached it).
 */
export async function POST(request: Request) {
  const rateLimit = enforceRateLimit(request, "booking-book", 10, 60_000);
  if (rateLimit.limited) return rateLimit.response;

  // `vet-public-api.yaml` documents only 400/409/429/5XX for this route (no 413), so an oversized
  // body is reported the same way as any other malformed request rather than introducing a status
  // code the wire contract does not define.
  const parsedBody = await readJsonBody(request, "booking-book");
  if (!parsedBody.ok) {
    return jsonWithHeaders(
      errorBody("invalid_input", parsedBody.tooLarge ? "Request body is too large." : "Malformed booking request."),
      {status: 400, headers: rateLimit.headers},
    );
  }
  const parsed = bookAppointmentRequestSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return jsonWithHeaders(errorBody("invalid_input", "Malformed booking request.", parsed.error.flatten()), {
      status: 400,
      headers: rateLimit.headers,
    });
  }

  const startAtMs = Date.parse(parsed.data.startAt);
  if (Number.isNaN(startAtMs)) {
    return jsonWithHeaders(errorBody("invalid_input", "startAt must be an ISO 8601 instant."), {
      status: 400,
      headers: rateLimit.headers,
    });
  }
  const startAt = Math.floor(startAtMs / 1000);

  await connectToDatabase();
  const service = await Service.findOne({
    serviceId: parsed.data.serviceId,
    active: true,
    bookableOnline: true,
  }).lean<ServiceDoc>();
  if (!service) {
    return jsonWithHeaders(errorBody("service_not_found", "Unknown or unbookable service."), {
      status: 400,
      headers: rateLimit.headers,
    });
  }
  const endAt = startAt + service.durationMinutes * 60;

  const config = await loadAvailabilityConfig();
  const now = Math.floor(Date.now() / 1000);
  if (startAt < now + config.settings.minNoticeMinutes * 60) {
    return jsonWithHeaders(errorBody("invalid_input", "This time no longer meets the minimum notice."), {
      status: 400,
      headers: rateLimit.headers,
    });
  }
  if (startAt > now + config.settings.maxAdvanceDays * 86400) {
    return jsonWithHeaders(errorBody("invalid_input", "This time is beyond the booking horizon."), {
      status: 400,
      headers: rateLimit.headers,
    });
  }

  const mobile = parsed.data.mobile;
  const settings = mobile ? await getClinicSettings() : undefined;

  // ── Section 2: the signed wallet claim - verified before anything else, rejects the WHOLE
  // booking on any failure (Q2). Pure local computation (no I/O), so this never has to weigh
  // against "an unreadable chain must not lose the booking" - that guarantee is about the TAG
  // CLAIM's chain reads below, a separate concern.
  let walletVerifiedAddress: string | undefined;
  let bookingHash: Hex | undefined;
  if (mobile?.wallet) {
    if (!settings?.cloneAddress) {
      return jsonWithHeaders(
        errorBody("clinic_not_configured", "This clinic has not completed setup for wallet-verified bookings."),
        {status: 503, headers: rateLimit.headers},
      );
    }
    bookingHash = computeMobileBookingHash({
      serviceId: parsed.data.serviceId,
      startAt,
      clientName: parsed.data.client.name,
      clientEmail: parsed.data.client.email,
      clientPhone: parsed.data.client.phone,
      dogTagIdField: mobile.pet?.dogTagIdField,
    });

    const verifyResult = await verifyMobileBookingWalletClaim({
      chainId: roax.id,
      clinicCloneAddress: settings.cloneAddress as Address,
      bookingHash,
      claimedWallet: mobile.wallet.address as Address,
      signature: mobile.wallet.signature as Hex,
      issuedAt: mobile.wallet.issuedAt,
      deadline: mobile.wallet.deadline,
      now,
    });
    if (!verifyResult.ok) {
      return jsonWithHeaders(
        errorBody("wallet_claim_invalid", walletClaimErrorMessage(verifyResult.reason), {reason: verifyResult.reason}),
        {status: 400, headers: rateLimit.headers},
      );
    }
    walletVerifiedAddress = verifyResult.wallet;

    // Replay protection: a signature that already booked something is rejected outright, never
    // silently re-processed - the unique partial index on `bookingIdentity.bookingHash`
    // (`models/Appointment.ts`) is the backstop against a genuine race between two concurrent
    // replays; this pre-check is what gives a clean, specific error the common case.
    const alreadyUsed = await Appointment.exists({"bookingIdentity.bookingHash": bookingHash});
    if (alreadyUsed) {
      return jsonWithHeaders(errorBody("wallet_claim_replayed", "This signed booking request has already been used."), {
        status: 400,
        headers: rateLimit.headers,
      });
    }
  }

  // ── Section 3: client resolution - wallet-match-first when the claim verified, else today's
  // email/phone match-or-create (unchanged).
  const client = walletVerifiedAddress
    ? await findOrCreateClientForMobileBooking({verifiedWalletAddress: walletVerifiedAddress, client: parsed.data.client})
    : await findOrCreateClientForBooking(parsed.data.client);

  // ── Tag-claim tier resolution - pure reads, zero writes (see resolveTagClaim's own doc comment
  // for why an unreadable chain here folds to "unknown" rather than rejecting the booking).
  let tagClaim: TagClaimResult = {tagResolution: "none"};
  if (mobile?.pet) {
    const env = getServerEnv();
    const chainDeps =
      env.DOGTAG_SBT_ADDRESS && env.VET_ISSUER_FACTORY_ADDRESS
        ? mongoMobileTagChainDeps(env.DOGTAG_SBT_ADDRESS as Address, env.VET_ISSUER_FACTORY_ADDRESS as Address)
        : unconfiguredMobileTagChainDeps();
    tagClaim = await resolveTagClaim(mongoMobileTagLookupStore, chainDeps, {
      dogTagIdDec: mobile.pet.dogTagIdDec,
      dogTagIdField: mobile.pet.dogTagIdField,
      resolvedClientId: client.clientId,
      ourCloneAddress: settings?.cloneAddress ?? "",
      leaves: mobile.pet.leaves,
      reservedLeafHashes: mobile.pet.reservedLeafHashes,
    });
  }

  const bookingIdentity: BookingIdentity | undefined = mobile
    ? toBookingIdentity({
        walletAddress: walletVerifiedAddress,
        walletVerified: Boolean(walletVerifiedAddress),
        bookingHash,
        dogTagIdDec: mobile.pet?.dogTagIdDec,
        tagClaim,
      })
    : undefined;

  const cancelToken = randomBytes(16).toString("hex");
  // Appointment.petName is required and non-blank per the v1 field vocabulary (wp4-vet.md) - and
  // mongoose's default String required-check rejects "" - but the wire request's petName is
  // optional, so fall back to a display placeholder rather than leaving it blank.
  const petName = parsed.data.petName?.trim() || mobile?.pet?.name?.trim() || "Pet";
  // Only tier 1's CLEAN local match (an already-existing, already-verified pet) goes straight into
  // the create draft - every other tier that ends in a pet link (Q3's external import) needs the
  // appointmentId first, so it is applied in a follow-up write below instead.
  const petIds = tagClaim.tagResolution === "local" && !tagClaim.needsReview ? [tagClaim.petId] : undefined;

  const draft: AppointmentDraft = {
    clientId: client.clientId,
    serviceId: service.serviceId,
    startAt,
    endAt,
    notes: parsed.data.notes,
    source: mobile ? "mobile" : "public_booking",
    clientName: client.name,
    petName,
    cancelToken,
    petIds,
    bookingIdentity,
  };

  let result: Awaited<ReturnType<typeof createAppointment>>;
  try {
    result = await createAppointment(draft, {enforceCapacity: true});
  } catch (err) {
    // The pre-check above already rejects the common case cleanly; this only fires when two
    // concurrent requests replaying the SAME signed claim both raced past that pre-check - the
    // partial unique index on `bookingIdentity.bookingHash` (`models/Appointment.ts`) is what
    // actually stops the second insert, surfacing as a Mongo duplicate-key error (11000) rather
    // than a thrown application error. Translated to the same reject response as the pre-check,
    // never a bare 500 - anything else re-throws unchanged.
    if (bookingHash && typeof err === "object" && err !== null && "code" in err && (err as {code?: unknown}).code === 11000) {
      return jsonWithHeaders(errorBody("wallet_claim_replayed", "This signed booking request has already been used."), {
        status: 400,
        headers: rateLimit.headers,
      });
    }
    throw err;
  }
  if (!result.ok) {
    if (result.reason === "outside_hours") {
      return jsonWithHeaders(errorBody("invalid_input", "This time is not within the clinic's bookable hours."), {
        status: 400,
        headers: rateLimit.headers,
      });
    }
    return jsonWithHeaders(errorBody("slot_conflict", "This time was just taken. Please pick another."), {
      status: 409,
      headers: rateLimit.headers,
    });
  }

  // ── Post-insert writes - only now that the appointment itself is durably booked.
  if (tagClaim.tagResolution === "external" && tagClaim.dataVerified) {
    let importedPetId: string;
    if (tagClaim.existingExternalPetId) {
      importedPetId = tagClaim.existingExternalPetId;
      await Promise.all([
        Pet.updateOne({petId: importedPetId}, {$addToSet: {ownerClientIds: client.clientId}}),
        Client.updateOne({clientId: client.clientId}, {$addToSet: {petIds: importedPetId}}),
      ]);
    } else {
      const attrs = tagClaim.verifiedAttributes ?? {};
      const importedName = attrs.name?.trim() || mobile?.pet?.name?.trim() || "Pet";
      const created = await Pet.create({
        name: importedName,
        species: attrs.species,
        breed: attrs.breed,
        sex: attrs.sex,
        dateOfBirth: attrs.dateOfBirth,
        ownerClientIds: [client.clientId],
        dogTag: {
          dogTagIdDec: mobile?.pet?.dogTagIdDec,
          dogTagIdField: tagClaim.dogTagIdField,
          root: tagClaim.root,
          cloneAddress: tagClaim.issuerClone,
          status: "active",
          external: true,
        },
        searchKey: buildPetSearchKey({name: importedName, species: attrs.species, breed: attrs.breed}),
      });
      importedPetId = created.petId;
      await Client.updateOne({clientId: client.clientId}, {$addToSet: {petIds: importedPetId}});
    }
    await Appointment.updateOne({appointmentId: result.appointment.appointmentId}, {$set: {petIds: [importedPetId]}});
    result.appointment.petIds = [importedPetId];
  }

  if (walletVerifiedAddress && bookingHash && mobile?.wallet && !clientAlreadyHasWallet(client, walletVerifiedAddress)) {
    const domain = buildMobileBookingDomain(roax.id, settings!.cloneAddress as Address);
    const message: MobileBookingMessage = {
      clinic: settings!.cloneAddress as Address,
      bookingHash,
      wallet: walletVerifiedAddress as Address,
      issuedAt: BigInt(mobile.wallet.issuedAt),
      deadline: BigInt(mobile.wallet.deadline),
    };
    const receipt: ReceiptRecord = {
      payloadJson: canonicalPayloadJson(domain, toWireMessage(message)),
      signature: mobile.wallet.signature,
      recoveredAt: now,
    };
    await appendBookingWalletToClient(client.clientId, {
      address: walletVerifiedAddress,
      via: "booking",
      bookingId: result.appointment.appointmentId,
      receipt,
      receiptHash: computeReceiptHash(receipt),
      issuedAt: mobile.wallet.issuedAt,
      registeredAt: now,
    });
  }

  const ics = await sendBookingConfirmation({
    appointment: result.appointment,
    serviceName: service.name,
    clientEmail: parsed.data.client.email,
    clientName: client.name,
    // `mobile.pet.name` (when the wire's own `petName` was omitted, as an app booking's is likely
    // to be - the app has its own picker instead) makes the same "your pet" vs. a real name
    // distinction `sendBookingConfirmation` already draws, just fed from either wire source.
    petName: parsed.data.petName ?? mobile?.pet?.name,
    notes: parsed.data.notes,
  });

  return jsonWithHeaders(
    {
      appointmentId: result.appointment.appointmentId,
      status: toPublicAppointmentStatus(result.appointment.status),
      ics,
      // Section 0 fix: the manage credential (cancelToken) previously went out ONLY in the
      // confirmation email link - both apps already read `response.token ?? appointmentId`, which
      // 401ed forever against `/v1/booking/appointments/:id` without this.
      token: result.appointment.cancelToken,
    },
    {status: 201, headers: rateLimit.headers},
  );
}
