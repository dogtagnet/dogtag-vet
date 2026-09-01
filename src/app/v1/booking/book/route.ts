import {randomBytes} from "node:crypto";
import type {Address, Hex} from "viem";
import {createAppointment} from "@/lib/booking/lifecycle";
import {loadAvailabilityConfig} from "@/lib/booking/queries";
import {findOrCreateClientForBooking, findOrCreateClientForMobileBooking} from "@/lib/booking/clientMatch";
import {sendBookingConfirmation} from "@/lib/booking/confirmation";
import {toPublicAppointmentStatus} from "@/lib/booking/status";
import {computeMobileBookingHash} from "@/lib/booking/bookingHash";
import {verifyMobileBookingWalletClaim, type MobileBookingWalletClaimInvalidReason} from "@/lib/booking/walletClaim";
import {mongoMobileTagChainDeps, mongoMobileTagLookupStore, mongoPostBookingStore, unconfiguredMobileTagChainDeps} from "@/lib/booking/mobileMongoAdapters";
import {applyPostBookingSideEffects} from "@/lib/booking/postBooking";
import {resolveTagClaim, toBookingIdentity, type TagClaimResult} from "@/lib/booking/mobileReconcile";
import {connectToDatabase} from "@/lib/db";
import {roax} from "@/lib/chains";
import {getServerEnv} from "@/lib/env";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import type {AppointmentDraft} from "@/lib/booking/mongoStore";
import {Appointment, type BookingIdentity} from "@/lib/models/Appointment";
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
  // email/phone match-or-create (unchanged). Review finding 6: the wallet path resolves
  // deterministically when the same wallet legitimately sits on multiple client records (earliest
  // active registration of the wallet wins) and reports the multi-match so it lands on
  // `bookingIdentity.walletMultiMatch` for staff, never a silent arbitrary pick.
  const resolvedClient = walletVerifiedAddress
    ? await findOrCreateClientForMobileBooking({verifiedWalletAddress: walletVerifiedAddress, client: parsed.data.client})
    : {client: await findOrCreateClientForBooking(parsed.data.client), walletMultiMatch: false};
  const client = resolvedClient.client;

  // ── Tag-claim tier resolution - pure reads, zero writes (see resolveTagClaim's own doc comment
  // for why an unreadable chain here folds to "unknown" rather than rejecting the booking).
  let tagClaim: TagClaimResult = {tagResolution: "none"};
  if (mobile?.pet) {
    const env = getServerEnv();
    // Review finding 7: tiers 3/4 discriminate "issued by THIS clinic" from "issued elsewhere"
    // purely by comparing the chain's `rootIssuer` against `settings.cloneAddress` - without that
    // address, a genuinely local ("issued_here_unlinked") tag cannot be told apart from a foreign
    // one at all, so it must never be allowed to fall through and get classified as "external"
    // against an empty-string clone (which the wallet-claim path already 503s on, but a pet-only
    // claim has no wallet block to gate that check on). Route through the SAME "chain not
    // configured" fail-closed idiom `unconfiguredMobileTagChainDeps` already provides for missing
    // env vars: every chain read throws, `resolveTagClaim` folds that to `unknown`/
    // `verificationError: true` - never losing the booking (tier 1's local lookup is unaffected,
    // it never needs the clone address at all).
    const chainDeps =
      env.DOGTAG_SBT_ADDRESS && env.VET_ISSUER_FACTORY_ADDRESS && settings?.cloneAddress
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
        walletMultiMatch: resolvedClient.walletMultiMatch,
        tagClaim,
      })
    : undefined;

  const cancelToken = randomBytes(16).toString("hex");
  // Only tier 1's CLEAN local match (an already-existing, already-verified pet) goes straight into
  // the create draft - every other tier that ends in a pet link (Q3's external import) needs the
  // appointmentId first, so it is applied in a follow-up write below instead.
  const cleanLocalMatch = tagClaim.tagResolution === "local" && !tagClaim.needsReview ? tagClaim : undefined;
  const petIds = cleanLocalMatch ? [cleanLocalMatch.petId] : undefined;
  // Appointment.petName is required and non-blank per the v1 field vocabulary (wp4-vet.md) - and
  // mongoose's default String required-check rejects "" - but the wire request's petName is
  // optional, so fall back to a display placeholder rather than leaving it blank. Review finding 3:
  // a tier-1 clean match's ACTUAL pet record wins over whatever display name the wire merely
  // asserted (`mobile.pet.name`/`petName` are unverified hints - see `bookingIdentity`'s own doc
  // comment) - otherwise the appointments list shows a stale or plain-wrong name for a booking that
  // just linked correctly, the exact WP4.3 A1 no-drift invariant `relink-dogtag`'s write already
  // follows (`petName: pet.name`).
  const petName = cleanLocalMatch?.name.trim() || parsed.data.petName?.trim() || mobile?.pet?.name?.trim() || "Pet";

  const draft: AppointmentDraft = {
    clientId: client.clientId,
    serviceId: service.serviceId,
    // WP4.7 D5 - absent (undefined) in clinic mode is a no-op (createAppointment never reads it
    // there); absent in practitioner mode means "auto-assign". A present value that turns out not
    // to name a real bookable practitioner is rejected below (`invalid_practitioner`), never
    // silently ignored.
    practitionerStaffId: parsed.data.practitionerId,
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
    if (result.reason === "invalid_practitioner") {
      return jsonWithHeaders(errorBody("invalid_input", "Unknown or unbookable practitioner."), {
        status: 400,
        headers: rateLimit.headers,
      });
    }
    return jsonWithHeaders(errorBody("slot_conflict", "This time was just taken. Please pick another."), {
      status: 409,
      headers: rateLimit.headers,
    });
  }

  // ── Post-insert side effects - only now that the appointment itself is durably booked. Review
  // finding 4: extracted to `applyPostBookingSideEffects` (`lib/booking/postBooking.ts`), whose
  // one contract is that a failure in here can no longer 500 a booking that already durably
  // exists - by this point the appointment is created and (when a wallet claim was involved) its
  // `bookingHash` is burned into the replay guard, so a thrown error would leave the client
  // retrying a booking that exists and being told "already used" with nothing to show for it.
  // The module traps every failure, flags `bookingIdentity.postBookingIncomplete` for staff
  // review (a warning banner in the provenance box), and the response below returns the created
  // appointment + manage token regardless. Q3's import/reuse (with review finding 3's petName
  // rebuild) and Q1's wallet auto-attach keep their exact write shapes - see the module and
  // `mongoPostBookingStore`'s own doc comments.
  await applyPostBookingSideEffects(mongoPostBookingStore, {
    appointmentId: result.appointment.appointmentId,
    client: {clientId: client.clientId, wallets: client.wallets},
    tagClaim,
    fallbackPetName: petName,
    wirePetName: mobile?.pet?.name,
    wireDogTagIdDec: mobile?.pet?.dogTagIdDec,
    wallet:
      walletVerifiedAddress && bookingHash && mobile?.wallet
        ? {
            verifiedAddress: walletVerifiedAddress,
            bookingHash,
            signature: mobile.wallet.signature,
            issuedAt: mobile.wallet.issuedAt,
            deadline: mobile.wallet.deadline,
            clinicCloneAddress: settings!.cloneAddress as Address,
            chainId: roax.id,
          }
        : undefined,
    now,
  });

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
