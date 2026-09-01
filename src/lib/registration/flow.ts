import {recoverTypedDataAddress} from "viem";
import type {Address, Hex} from "viem";
import {
  CLIENT_REGISTRATION_PRIMARY_TYPE,
  CLIENT_REGISTRATION_TYPES,
  buildClientRegistrationDomain,
  canonicalPayloadJson,
  toWireMessage,
  type ClientRegistrationMessage,
} from "@/lib/registration/eip712";
import {registrationIdToHex32} from "@/lib/registration/uuid";
import {computeReceiptHash, type ReceiptRecord} from "@/lib/registration/receipt";

/**
 * Everything the pure registration flow needs to know about a session, independent of the
 * mongoose document shape - mirrors `lib/mint/flow.ts`'s `MintSessionRow`, letting
 * `resolveRegistrationChallenge`/`completeRegistration`/`getRegistrationSessionStatus` below be
 * exercised against an in-memory fake (`tests/unit/registration/flow.test.ts`) with no live
 * database.
 *
 * `clinic`, `chainId`, `clinicName`, and `maskedClientName` are all snapshotted at session
 * creation (`lib/registration/createSession.ts` + the create-session route) rather than re-read
 * live from `ClinicSettings`/`Client` on every resolve - so the public `GET /w/:token` route
 * never needs to touch either of those collections at all, only this session row, exactly like
 * mint's `resolveMintSession` only ever reads `BindToken`+`MintSession`.
 */
export interface RegistrationSessionRow {
  token: string;
  registrationId: string;
  clientId: string;
  clinic: string; // clone address, lowercase 0x hex
  chainId: number;
  clinicName: string;
  maskedClientName: string;
  clientHash: string;
  issuedAt: number;
  blockNumber: number;
  deadline: number; // unix seconds
  consumed: boolean;
  consumedAt?: number;
  /** WP4.5 track3-sig fix 3 - the TRUE reason `completeRegistration` ended the way it did, set by
   * that function itself at the moment it knows (never re-derived later). Absent on every session
   * from before this field existed (backward-safe - `getRegistrationSessionStatus` falls back to
   * its pre-existing consumed-with-no-wallet inference for those). Deliberately only two values:
   * `"registered"` mirrors what `findClientWalletByRegistrationId` would independently confirm
   * anyway (never the sole source of truth for the "registered" status itself - see that function's
   * own doc comment on why), while `"signature_invalid"` is the ONE case that earns the "signature
   * did not match" accusation. Every OTHER way this can end (`already_registered`, `not_found`, a
   * `recordOutcome` write itself failing) deliberately leaves this unset, so the status poll's
   * "failed" copy stays honest by DEFAULT (a plain, non-accusatory "could not be completed") unless
   * this specifically says otherwise - the false-accusation incident this whole fix responds to was
   * exactly a case where the signature was fine and something else silently failed. */
  outcome?: "registered" | "signature_invalid";
}

/** The full wallet entry `appendWalletToClient` pushes onto `Client.wallets[]` - structurally
 * matches `ClientWallet` (`lib/models/Client.ts`) minus `label`/`revokedAt`, which don't exist
 * yet at registration time. Defined here rather than imported from the model file so this module
 * stays free of any mongoose dependency (importable from `scripts/verify-receipt.ts` if it ever
 * needed to, and testable with zero database). */
export interface AppendWalletInput {
  address: string; // lowercase 0x hex
  registrationId: string;
  receipt: ReceiptRecord;
  receiptHash: string;
  issuedAt: number;
  blockNumber: number;
  registeredAt: number;
}

export type AppendWalletResult = "ok" | "not_found" | "already_registered";

export interface RegistrationFlowStore {
  getByToken(token: string): Promise<RegistrationSessionRow | null>;
  getByRegistrationId(registrationId: string): Promise<RegistrationSessionRow | null>;
  /** Atomically flips `consumed: false -> true` and stamps `consumedAt`. Returns `false` if the
   * token was already consumed (a concurrent or repeat call lost the race, or already won it) -
   * `findOneAndUpdate({token, consumed:false})` in the mongo adapter. */
  tryConsume(token: string, now: number): Promise<boolean>;
  /** Atomically appends `entry` to `clientId`'s `wallets[]` UNLESS that address is already
   * present (any status, revoked or not) - single round trip, no separate check-then-push race
   * window. `not_found` if the client itself doesn't exist. */
  appendWalletToClient(clientId: string, entry: AppendWalletInput): Promise<AppendWalletResult>;
  /** Reads `Client.wallets[]` directly for an entry matching `registrationId` - the SOLE source
   * of truth `getRegistrationSessionStatus` uses to report "registered", rather than a redundant
   * flag on the session row that a crash between the append and a second write could leave
   * inconsistent. */
  findClientWalletByRegistrationId(clientId: string, registrationId: string): Promise<{address: string} | null>;
  /** Persists `RegistrationSessionRow.outcome` (WP4.5 track3-sig fix 3) - best-effort bookkeeping,
   * never load-bearing for `completeRegistration`'s own return value: a failure here must not turn
   * a genuine `signature_invalid`/success outcome into something else, so `completeRegistration`
   * never lets a `recordOutcome` failure affect what it returns to its caller. */
  recordOutcome(token: string, outcome: "registered" | "signature_invalid"): Promise<void>;
}

function isConsumedOrExpired(session: RegistrationSessionRow, now: number): boolean {
  return session.consumed || now > session.deadline;
}

/** `RegistrationFlowStore.recordOutcome` is explicitly best-effort (see its own doc comment) -
 * this is the one place that swallows its failure, so neither call site in `completeRegistration`
 * below has to remember to. */
async function recordOutcomeBestEffort(
  store: RegistrationFlowStore,
  token: string,
  outcome: "registered" | "signature_invalid",
): Promise<void> {
  try {
    await store.recordOutcome(token, outcome);
  } catch {
    // Truthful-status bookkeeping only - never lets a write failure here change what
    // completeRegistration itself returns to its caller.
  }
}

function buildMessage(session: RegistrationSessionRow, wallet: Address): ClientRegistrationMessage {
  return {
    clinic: session.clinic as Address,
    clientHash: session.clientHash as Hex,
    registrationId: registrationIdToHex32(session.registrationId),
    wallet,
    issuedAt: BigInt(session.issuedAt),
    blockNumber: BigInt(session.blockNumber),
    deadline: BigInt(session.deadline),
  };
}

export type ResolveChallengeResult =
  | {ok: true; session: RegistrationSessionRow; ttlSecs: number}
  | {ok: false; status: 404 | 410};

/**
 * `GET /w/:token` - non-consuming, never touches `consumed`. Unlike the staff status poll below,
 * this 410s IMMEDIATELY once the token is consumed - there is no reason for the owner's own
 * device to keep polling the challenge after it already knows the outcome from its own
 * `/complete` response, so no grace window applies here (see `getRegistrationSessionStatus`'s doc
 * comment for where the grace window DOES apply, and why).
 */
export async function resolveRegistrationChallenge(
  store: RegistrationFlowStore,
  token: string,
  now: number,
): Promise<ResolveChallengeResult> {
  const session = await store.getByToken(token);
  if (!session) return {ok: false, status: 404};
  if (isConsumedOrExpired(session, now)) return {ok: false, status: 410};
  return {ok: true, session, ttlSecs: Math.max(0, session.deadline - now)};
}

export interface CompleteRegistrationInput {
  token: string;
  wallet: string; // 0x address, as claimed by the request body
  signature: string; // 0x + 130 hex
}

export type CompleteRegistrationResult =
  | {ok: true; clientId: string; wallet: string; receiptHash: string}
  | {ok: false; code: "not_found"}
  | {ok: false; code: "expired_or_reused"}
  | {ok: false; code: "signature_invalid"}
  | {ok: false; code: "already_registered"};

/**
 * `POST /w/:token/complete`. Order of operations (plans/wp4.2-client-wallet-registration.md,
 * dogtag-vet section 4):
 *
 * 1. Pre-check `consumed`/`deadline` against the already-fetched row, BEFORE attempting to
 *    consume - avoids burning a token that was always going to fail (mirrors
 *    `lib/mint/flow.ts`'s `custodialBind`, which checks `tokenRow.exp` before calling
 *    `tryConsumeToken`). Both "already used" and "naturally expired" collapse into the single
 *    `expired_or_reused` code the spec defines for registration (unlike mint, which splits these
 *    into `already_bound` vs `expired_or_reused` because mint's 409 carries a `dogTagId` payload
 *    the spec has no registration-side equivalent for).
 * 2. Atomically consume - a lost race against a concurrent completion is ALSO `expired_or_reused`.
 * 3. Rebuild the exact EIP-712 domain/message from the session's own server-trusted snapshot
 *    (never from anything the request body supplies except the claimed `wallet` itself, which is
 *    part of the signed struct) and independently recover the signer
 *    (`recoverTypedDataAddress`, same pattern as the C3 attestation route) - called directly, not
 *    injected, since unlike a chain read this is pure local computation with no I/O to fake.
 * 4. The recovered signer MUST equal the claimed `wallet` - otherwise `signature_invalid`. A
 *    signature that fails this check still burned the token in step 2: there is no `/retry` here,
 *    so a garbled or wrong-signer submission against a real QR permanently kills it (documented
 *    in docs/client-wallet-registration.md; the UI must not imply "waiting" can still resolve
 *    once a `failed` status poll is observed).
 * 5. Append the receipt to `Client.wallets[]`, atomically guarding against a duplicate address on
 *    this client (`already_registered`, 409) - checked only AFTER signature verification, so an
 *    unauthenticated caller can never learn whether a wallet is already registered by probing
 *    with a signature they don't actually hold.
 */
export async function completeRegistration(
  store: RegistrationFlowStore,
  input: CompleteRegistrationInput,
  now: number,
): Promise<CompleteRegistrationResult> {
  const session = await store.getByToken(input.token);
  if (!session) return {ok: false, code: "not_found"};
  if (isConsumedOrExpired(session, now)) return {ok: false, code: "expired_or_reused"};

  const consumed = await store.tryConsume(input.token, now);
  if (!consumed) return {ok: false, code: "expired_or_reused"};

  const domain = buildClientRegistrationDomain(session.chainId, session.clinic as Address);
  const message = buildMessage(session, input.wallet as Address);

  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain,
      types: CLIENT_REGISTRATION_TYPES,
      primaryType: CLIENT_REGISTRATION_PRIMARY_TYPE,
      message,
      signature: input.signature as Hex,
    });
  } catch {
    await recordOutcomeBestEffort(store, input.token, "signature_invalid");
    return {ok: false, code: "signature_invalid"};
  }
  if (recovered.toLowerCase() !== input.wallet.toLowerCase()) {
    await recordOutcomeBestEffort(store, input.token, "signature_invalid");
    return {ok: false, code: "signature_invalid"};
  }

  const walletLower = input.wallet.toLowerCase();
  const payloadJson = canonicalPayloadJson(domain, toWireMessage(message));
  const receipt: ReceiptRecord = {payloadJson, signature: input.signature, recoveredAt: now};
  const receiptHash = computeReceiptHash(receipt);

  const appendResult = await store.appendWalletToClient(session.clientId, {
    address: walletLower,
    registrationId: session.registrationId,
    receipt,
    receiptHash,
    issuedAt: session.issuedAt,
    blockNumber: session.blockNumber,
    registeredAt: now,
  });
  if (appendResult === "not_found") return {ok: false, code: "not_found"};
  if (appendResult === "already_registered") return {ok: false, code: "already_registered"};

  // Deliberately NOT recorded for `not_found`/`already_registered` above (see `outcome`'s own doc
  // comment) - both leave the session's `outcome` unset, falling back to today's inference.
  await recordOutcomeBestEffort(store, input.token, "registered");
  return {ok: true, clientId: session.clientId, wallet: walletLower, receiptHash};
}

/** How long the staff status poll keeps answering `registered`/`failed` after the token is
 * consumed, before reporting the session as simply gone - same constant and same rationale as
 * `lib/mint/flow.ts`'s `STATUS_GRACE_PERIOD_SECS` ("a slow owner does not lose the session to the
 * counter clerk's original short-lived QR window"; here, the staff member watching the panel
 * doesn't lose the outcome the instant it happens). */
export const STATUS_GRACE_PERIOD_SECS = 3600;

export type RegistrationStatus = "waiting" | "registered" | "failed" | "expired";

export type GetRegistrationStatusResult =
  | {ok: true; status: RegistrationStatus; wallet?: string; outcome?: "registered" | "signature_invalid"}
  | {ok: false; status: 404};

/**
 * The staff-facing poll (`GET /api/clients/:id/wallet-registrations/:registrationId`) - looked up
 * by `registrationId`, never the public bearer `token`, mirroring how mint's staff poll
 * (`GET /api/tags/issue/:sessionId`) uses the internal `sessionId` rather than the mint bind
 * token.
 *
 * `registered` is derived by reading `Client.wallets[]` directly for an entry whose
 * `registrationId` matches (`findClientWalletByRegistrationId`) - NOT from a redundant `wallet`
 * field on the session row - so a crash between `appendWalletToClient` succeeding and any second
 * write can never leave this poll reporting the wrong thing for a registration that actually did
 * succeed.
 *
 * `failed` (consumed, no matching wallet, still within the grace window) covers the
 * `signature_invalid`/`already_registered` outcome: the token is permanently spent (no `/retry`),
 * so the UI must offer "generate a new code", never imply the existing one might still resolve.
 * Once past the grace window with still no matching wallet, this reports `expired` instead -
 * from the staff's perspective a `failed` registration this old is exactly as actionable as a
 * `waiting` one that plain timed out: generate a fresh code.
 *
 * WP4.5 track3-sig fix 3: `failed` alone used to be the ONLY signal the panel had, and its copy
 * ("Signature didn't match") assumed every `failed` was a bad signature - a false accusation on
 * the forensic incident, where the real cause was a server-side write that silently never landed.
 * `outcome` (the session row's own `RegistrationSessionRow.outcome`, set by `completeRegistration`
 * itself at the moment it knows) is passed straight through on `failed` so the caller can tell a
 * CONFIRMED bad signature apart from every other way this can end up `failed` - absent `outcome`
 * (a session from before this field existed, or any outcome this repo deliberately never records -
 * see that field's own doc comment) means "not confirmed as a signature problem", not "assume it
 * was one".
 *
 * `clientId` scopes the lookup: a `registrationId` that resolves to a DIFFERENT client's session
 * reports 404, identically to a `registrationId` that does not exist at all - the route path
 * already names a client (`/api/clients/:id/wallet-registrations/:registrationId`), so a
 * registrationId that belongs to some other client must never leak its status through this one.
 */
export async function getRegistrationSessionStatus(
  store: RegistrationFlowStore,
  clientId: string,
  registrationId: string,
  now: number,
): Promise<GetRegistrationStatusResult> {
  const session = await store.getByRegistrationId(registrationId);
  if (!session || session.clientId !== clientId) return {ok: false, status: 404};

  if (!session.consumed) {
    return {ok: true, status: now > session.deadline ? "expired" : "waiting"};
  }

  const registeredWallet = await store.findClientWalletByRegistrationId(session.clientId, session.registrationId);
  if (registeredWallet) return {ok: true, status: "registered", wallet: registeredWallet.address};

  const pastGrace = session.consumedAt !== undefined && now > session.consumedAt + STATUS_GRACE_PERIOD_SECS;
  if (pastGrace) return {ok: true, status: "expired"};
  return {ok: true, status: "failed", outcome: session.outcome};
}
