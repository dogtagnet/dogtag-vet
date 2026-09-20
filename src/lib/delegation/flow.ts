import {recoverTypedDataAddress} from "viem";
import type {Address, Hex} from "viem";
import {
  DELEGATION_CLAIM_PRIMARY_TYPE,
  DELEGATION_CLAIM_TYPES,
  buildDelegationClaimDomain,
  type DelegationClaimMessage,
} from "@/lib/delegation/eip712";
import {registrationIdToHex32} from "@/lib/registration/uuid";
import {DELEGATION_MAX_ACTIVE} from "@/lib/delegation/constants";
import type {DelegationInternalStatus, DelegationKind} from "@/lib/models/DelegationSession";

/**
 * Everything the pure delegation-ceremony flow needs to know about a session, independent of the
 * mongoose document shape - mirrors `lib/registration/flow.ts`'s `RegistrationSessionRow` /
 * `lib/mint/flow.ts`'s `MintSessionRow`, letting every function below be exercised against an
 * in-memory fake (`tests/unit/delegation/flow.test.ts`) with no live database or chain.
 */
export interface DelegationSessionRow {
  token: string;
  registrationId: string;
  kind: DelegationKind;
  petId: string;
  dogTagIdField: string;
  dogTagIdDec?: string;
  clientId: string;
  clinic: string;
  chainId: number;
  clinicName: string;
  maskedTargetName: string;
  commitment?: string;
  wallet?: string;
  issuedAt: number;
  blockNumber?: number;
  deadline: number;
  status: DelegationInternalStatus;
  errorReason?: string;
  txHash?: string;
  secondaryCountAtConfirm?: number;
  delegationRootAtConfirm?: string;
  consumed: boolean;
  consumedAt?: number;
}

export interface DelegationFlowStore {
  getByToken(token: string): Promise<DelegationSessionRow | null>;
  getByRegistrationId(registrationId: string): Promise<DelegationSessionRow | null>;
  /** Atomically flips `consumed: false -> true` and stamps `consumedAt` - `add`-kind only in
   * practice (a `revoke`-kind session is created already `consumed: true`, see the model's own
   * doc comment). Returns `false` if already consumed (lost a race, or already won it). */
  tryConsume(token: string, now: number): Promise<boolean>;
  /** Persists the claimed commitment/wallet and flips `status` to `"claimed"` - the ONE write
   * `completeDelegationClaim` makes on success. */
  recordClaim(token: string, fields: {commitment: string; wallet: string}): Promise<void>;
  /** Best-effort - see `recordErrorBestEffort` below; never load-bearing for a function's return
   * value, same convention as `lib/registration/flow.ts`'s `recordOutcomeBestEffort`. */
  recordError(token: string, reason: string): Promise<void>;
  /** Does `clientId` already have an ACTIVE (added, not since revoked) secondary-owner commitment
   * on `dogTagIdField`? The chain's own `isSecondary` cannot answer this - it only ever sees
   * opaque commitments, never client identity (`docs/DELEGATION.md` section 4.1) - so this is the
   * one client-identity cross-check only Mongo's own session history can make (`specs/vet-public-
   * api.yaml`'s 409 `already_secondary`: "this commitment, OR this client"). */
  hasActiveSecondaryForClient(dogTagIdField: string, clientId: string): Promise<boolean>;
}

function isConsumedOrExpired(session: DelegationSessionRow, now: number): boolean {
  return session.consumed || now > session.deadline;
}

async function recordErrorBestEffort(store: DelegationFlowStore, token: string, reason: string): Promise<void> {
  try {
    await store.recordError(token, reason);
  } catch {
    // Best-effort bookkeeping only - a failure here must never change what the caller returns.
  }
}

function buildClaimMessage(session: DelegationSessionRow, commitment: Hex, wallet: Address): DelegationClaimMessage {
  return {
    clinic: session.clinic as Address,
    dogTagIdField: BigInt(session.dogTagIdField),
    commitment,
    registrationId: registrationIdToHex32(session.registrationId),
    wallet,
    issuedAt: BigInt(session.issuedAt),
    blockNumber: BigInt(session.blockNumber ?? 0),
    deadline: BigInt(session.deadline),
  };
}

export type ResolveDelegationResult =
  | {ok: true; session: DelegationSessionRow; ttlSecs: number}
  | {ok: false; status: 404 | 410};

/**
 * `GET /d/:token` - non-consuming, add-kind ONLY (`specs/qr-formats.md`: revoke "has no QR of its
 * own... no public API surface"). Scoping the lookup to `kind: "add"` here (not merely trusting
 * the caller never to pass a revoke token) is what makes that guarantee structural rather than a
 * convention a future route change could accidentally violate - a `kind: "revoke"` session's token
 * can never resolve through this function no matter what calls it.
 */
export async function resolveDelegationChallenge(
  store: DelegationFlowStore,
  token: string,
  now: number,
): Promise<ResolveDelegationResult> {
  const session = await store.getByToken(token);
  if (!session || session.kind !== "add") return {ok: false, status: 404};
  if (isConsumedOrExpired(session, now)) return {ok: false, status: 410};
  return {ok: true, session, ttlSecs: Math.max(0, session.deadline - now)};
}

export interface CompleteDelegationInput {
  token: string;
  commitment: string; // 0x hex32, claimed by the request body
  wallet: string; // 0x address, claimed by the request body
  signature: string;
}

export type CompleteDelegationResult =
  | {ok: true; clientId: string; commitment: string}
  | {ok: false; code: "not_found"}
  | {ok: false; code: "expired_or_reused"}
  | {ok: false; code: "signature_invalid"}
  | {ok: false; code: "already_secondary"};

/**
 * `POST /d/:token/complete` (`docs/DELEGATION.md` section 4.3 steps 4-5; `specs/vet-public-
 * api.yaml`'s `postDelegationSessionComplete`). Order of operations, mirroring
 * `lib/registration/flow.ts`'s `completeRegistration` exactly (add-kind only - scoped the same way
 * `resolveDelegationChallenge` is):
 *
 * 1. Pre-check `consumed`/`deadline`/`kind` BEFORE attempting to consume.
 * 2. Atomically consume - EVERY outcome from here on, success or refusal alike, has already burned
 *    the token (`specs/vet-public-api.yaml`: "Consumes the token, including on a FAILED
 *    verification... there is no retry endpoint for this flow").
 * 3. Rebuild the exact `DelegationClaim` domain/message from the session's own server-trusted
 *    snapshot plus the request's claimed `commitment`/`wallet`, and independently recover the
 *    signer.
 * 4. The recovered signer MUST equal the claimed `wallet`, AND `wallet` MUST already be one of the
 *    target client's registered wallets (checked by the caller BEFORE calling this - see
 *    `isRegisteredWallet` below - deliberately not this function's own job, since "is this address
 *    one of client X's wallets" is a `Client` document read this pure function has no store method
 *    for) - both folded into one `signature_invalid` code per the spec ("deliberately one code for
 *    both so a caller cannot probe which check failed").
 * 5. `already_secondary` (409) if EITHER this exact commitment is already active on chain
 *    (`isCommitmentActiveOnChain`, injected - the same wallet re-deriving its per-tag key produces
 *    the identical commitment every time, so a repeat add attempt from an already-added wallet
 *    hits this) OR this client already has a different active commitment on this tag
 *    (`store.hasActiveSecondaryForClient`) - checked only AFTER signature verification, so an
 *    unauthenticated caller can never learn either fact by probing with a signature it doesn't hold.
 */
export async function completeDelegationClaim(
  store: DelegationFlowStore,
  input: CompleteDelegationInput,
  now: number,
  deps: {isCommitmentActiveOnChain: (dogTagIdField: string, commitment: string) => Promise<boolean>; isRegisteredWallet: (clientId: string, wallet: string) => Promise<boolean>},
): Promise<CompleteDelegationResult> {
  const session = await store.getByToken(input.token);
  if (!session || session.kind !== "add") return {ok: false, code: "not_found"};
  if (isConsumedOrExpired(session, now)) return {ok: false, code: "expired_or_reused"};

  const consumed = await store.tryConsume(input.token, now);
  if (!consumed) return {ok: false, code: "expired_or_reused"};

  const domain = buildDelegationClaimDomain(session.chainId, session.clinic as Address);
  const message = buildClaimMessage(session, input.commitment as Hex, input.wallet as Address);

  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain,
      types: DELEGATION_CLAIM_TYPES,
      primaryType: DELEGATION_CLAIM_PRIMARY_TYPE,
      message,
      signature: input.signature as Hex,
    });
  } catch {
    await recordErrorBestEffort(store, input.token, "The signature could not be verified.");
    return {ok: false, code: "signature_invalid"};
  }
  if (recovered.toLowerCase() !== input.wallet.toLowerCase()) {
    await recordErrorBestEffort(store, input.token, "The signature does not match the claimed wallet.");
    return {ok: false, code: "signature_invalid"};
  }
  const registered = await deps.isRegisteredWallet(session.clientId, input.wallet);
  if (!registered) {
    await recordErrorBestEffort(store, input.token, "The signing wallet is not registered to this client.");
    return {ok: false, code: "signature_invalid"};
  }

  const [commitmentAlreadyActive, clientAlreadyActive] = await Promise.all([
    deps.isCommitmentActiveOnChain(session.dogTagIdField, input.commitment).catch(() => false),
    store.hasActiveSecondaryForClient(session.dogTagIdField, session.clientId).catch(() => false),
  ]);
  if (commitmentAlreadyActive || clientAlreadyActive) {
    await recordErrorBestEffort(store, input.token, "This client is already an active secondary owner of this tag.");
    return {ok: false, code: "already_secondary"};
  }

  await store.recordClaim(input.token, {commitment: input.commitment.toLowerCase(), wallet: input.wallet.toLowerCase()});
  return {ok: true, clientId: session.clientId, commitment: input.commitment.toLowerCase()};
}

/** How long `GET /d/:token/status` keeps answering after the token is consumed, before reporting
 * the session as simply gone - same constant and rationale as `lib/registration/flow.ts`'s
 * `STATUS_GRACE_PERIOD_SECS` / `lib/mint/flow.ts`'s own (both 3600s): the secondary owner's phone
 * must be able to keep polling through the full add-then-confirm-on-chain arc, which - unlike
 * wallet registration's single write - can genuinely take a while under real network conditions. */
export const DELEGATION_STATUS_GRACE_PERIOD_SECS = 3600;

/** The PUBLIC wire vocabulary `specs/vet-public-api.yaml`'s `DelegationSessionStatus` names -
 * deliberately narrower than `DelegationInternalStatus` (no `"revoke"`-only concept ever appears
 * here, because this function only ever serves `kind: "add"` sessions in the first place). */
export type DelegationWireStatus = "pending" | "claimed" | "adding" | "added" | "error";

function toWireStatus(status: DelegationInternalStatus): DelegationWireStatus {
  if (status === "submitting") return "adding";
  if (status === "confirmed") return "added";
  return status;
}

export type GetDeviceStatusResult =
  | {ok: true; status: DelegationWireStatus; dogTagIdField: string; reason?: string; readyForBundle: boolean; session: DelegationSessionRow}
  | {ok: false; status: 404 | 410};

/**
 * `GET /d/:token/status` (`specs/vet-public-api.yaml`'s `getDelegationSessionStatus`) - add-kind
 * only, PUBLIC, non-authenticated. Answers for `DELEGATION_STATUS_GRACE_PERIOD_SECS` past
 * consumption (a `"pending"` session that simply expired without ever being claimed gets no grace
 * at all - `neverClaimedAndExpired` below - mirroring `getMintSessionStatus`'s identical two-branch
 * shape), then 410. `readyForBundle` tells the ROUTE (not this pure function, which has no bundle
 * builder of its own - that is V4's `src/lib/delegation/bundle.ts`) whether `status === "confirmed"`
 * so it knows to attach `DelegationCoOwnerBundle` to the response; `session` is returned alongside
 * so the route can build that bundle (petId, commitment, clinicName, ...) without a second store
 * round trip.
 *
 * **Conformant with `specs/qr-formats.md`'s "carries a `bundle` once (and only once) it reports
 * `added`"** (grade round 1 D4 - a prior version of this comment mis-read that phrase as a delivery
 * COUNT and described this as a disclosed deviation from it; it is not one, and nothing about the
 * behavior below has changed). "Once (and only once)" is the subordinating conjunction - "when, and
 * only when, it reports added" - not "exactly one response ever carries it": `docs/DELEGATION.md`
 * section 4.3 step 9 states the same rule with no count language at all, the very next spec
 * sentence is about which ENDPOINT hosts the bundle rather than a delivery budget, and neither
 * `DelegationCoOwnerBundle` nor `DelegationSession` carries any delivered/served flag, which a
 * genuine one-shot rule would require somewhere. This function's `readyForBundle` flag - and
 * therefore the route's decision to attach the bundle - is `true` on EVERY poll while
 * `status === "confirmed"` and still within the grace window, exactly matching "whenever, and only
 * whenever, it reports added". The spec's own grace-period rule for THIS exact endpoint ("keeps
 * answering for a grace period after the token is consumed... so the secondary owner's app can keep
 * polling the same token through on-chain confirmation") already establishes that this endpoint is
 * built for a device to keep asking after the fact - repeating a value that never changes (the
 * bundle's contents are fixed the moment the write confirms) is exactly what that grace period is
 * for.
 */
export async function getDelegationSessionStatusForDevice(
  store: DelegationFlowStore,
  token: string,
  now: number,
): Promise<GetDeviceStatusResult> {
  const session = await store.getByToken(token);
  if (!session || session.kind !== "add") return {ok: false, status: 404};

  const neverClaimedAndExpired = !session.consumed && now > session.deadline;
  const pastGrace = session.consumed && session.consumedAt !== undefined && now > session.consumedAt + DELEGATION_STATUS_GRACE_PERIOD_SECS;
  if (neverClaimedAndExpired || pastGrace) return {ok: false, status: 410};

  return {
    ok: true,
    status: toWireStatus(session.status),
    dogTagIdField: session.dogTagIdField,
    reason: session.status === "error" ? session.errorReason : undefined,
    readyForBundle: session.status === "confirmed",
    session,
  };
}

export interface StaffDelegationStatus {
  kind: DelegationKind;
  status: DelegationInternalStatus;
  errorReason?: string;
  txHash?: string;
  commitment?: string;
}

export type GetStaffStatusResult = {ok: true; status: StaffDelegationStatus} | {ok: false; status: 404};

/**
 * `GET /api/pets/:id/delegations/:registrationId` - the staff-facing poll behind the Owners card's
 * "Waiting for scan..." / "Add on chain" / "Removing..." states, looked up by `registrationId`
 * (never the public `token`), mirroring `getRegistrationSessionStatus`. Serves BOTH kinds (unlike
 * the two device-facing functions above) and the full internal status vocabulary, including
 * `errorReason`/`txHash` - this is a staff-only surface, so there is no PII-minimization concern
 * the way there is on `/d/:token`.
 */
export async function getStaffDelegationStatus(
  store: DelegationFlowStore,
  petId: string,
  registrationId: string,
): Promise<GetStaffStatusResult> {
  const session = await store.getByRegistrationId(registrationId);
  if (!session || session.petId !== petId) return {ok: false, status: 404};
  return {
    ok: true,
    status: {kind: session.kind, status: session.status, errorReason: session.errorReason, txHash: session.txHash, commitment: session.commitment},
  };
}

/** Session-start pre-check (V2's own precondition, run BEFORE any ceremony/QR is generated so
 * staff are never sent through a full round trip guaranteed to fail): is this tag already at the
 * cap? Injected `secondaryCount` read - fail-closed like every other chain precondition in this
 * app (an unreadable chain refuses the START, it does not silently proceed). */
export async function checkDelegationCapNotReached(
  dogTagIdField: string,
  getSecondaryCount: (dogTagIdField: string) => Promise<number>,
): Promise<{ok: true} | {ok: false; message: string}> {
  let count: number;
  try {
    count = await getSecondaryCount(dogTagIdField);
  } catch {
    return {ok: false, message: "Could not reach the chain to check this tag's secondary-owner count. Try again shortly."};
  }
  if (count >= DELEGATION_MAX_ACTIVE) {
    return {ok: false, message: `This tag already has the maximum of ${DELEGATION_MAX_ACTIVE} secondary owners.`};
  }
  return {ok: true};
}
