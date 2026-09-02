import {verifyLeafCommitment, type OpenedLeaf} from "@dogtag/standard";
import type {IdentityLeaf, MintErrorStage, MintSessionStatus, OwnerIdentity, MintProfile} from "@/lib/models/MintSession";
import type {MicrochipInfo} from "@/lib/models/Pet";

/**
 * Everything the pure mint flow needs to know about a session, independent of the mongoose
 * document shape - lets `resolveMintSession`/`getMintSessionStatus`/`custodialBind` below be
 * exercised against an in-memory fake (`tests/unit/mint.integration.test.ts`) with no live
 * database, exactly like `lib/booking/book.ts`'s `BookingStore` does for booking concurrency.
 */
export interface MintSessionRow {
  sessionId: string;
  dogTagIdDec: string;
  dogTagIdFieldDec: string;
  ownerIdentity: OwnerIdentity;
  identityLeaves: IdentityLeaf[];
  petName: string;
  microchip: MicrochipInfo;
  profile: MintProfile;
  status: MintSessionStatus;
  root?: string;
  errorStage?: MintErrorStage;
  /** WP4.9: the pet this session is FOR (`MintSessionDoc.petId`, always set at session creation -
   * `api/tags/issue/start/route.ts` either reuses an existing pet or creates one before the session
   * itself exists). Optional here (not on `MintSessionDoc`) only so every hand-rolled
   * `MintSessionRow` fixture already in this repo's tests keeps compiling unmodified; the
   * custodial-bind route's own issued-artifact side effect (`lib/tags/issuedArtifactSideEffect.ts`)
   * treats a missing value as a defensive, should-never-happen error, not a silent skip. */
  petId?: string;
}

export interface MintTokenRow {
  token: string;
  sessionId: string;
  exp: number;
  consumed: boolean;
  consumedAt?: number;
}

export interface MintFlowStore {
  getToken(token: string): Promise<MintTokenRow | null>;
  getSession(sessionId: string): Promise<MintSessionRow | null>;
  /** Idempotent: only actually extends `exp` the first time it is called for this session (the
   * store is responsible for tracking "already extended once" - `firstResolvedAt` in the mongoose
   * adapter). Always returns the token's current `exp` after the call, extended or not. */
  extendTtlOnFirstResolve(token: MintTokenRow, now: number, minExp: number): Promise<number>;
  /** Atomically flips `consumed: false -> true` and stamps `consumedAt`. Returns `false` if the
   * token was already consumed (a concurrent or repeat call lost the race, or already won it). */
  tryConsumeToken(token: string, now: number): Promise<boolean>;
  /** Persists the session as `ready` with the given root/leaves. Called only after the caller has
   * already confirmed both the local bind-commitment check and the on-chain "still unset" recheck
   * pass - this method itself does no chain I/O, so it can never be the thing that turns an
   * unreadable chain into a false "seal" success. */
  commitReady(
    session: MintSessionRow,
    result: {root: string; boundLeaves: OpenedLeaf[]; reservedLeafHashes: string[]},
  ): Promise<void>;
  markError(sessionId: string, stage: MintErrorStage): Promise<void>;
}

export type ResolveMintSessionResult =
  | {ok: true; session: MintSessionRow; ttlSecs: number}
  | {ok: false; status: 404 | 410};

const STATUS_GRACE_PERIOD_SECS = 3600; // vet-public-api.yaml's /p/:token/status doc comment
const RESOLVE_TTL_EXTENSION_SECS = 300; // /p/:token doc comment: "extends exp to max(current, now+300)"

/**
 * `GET /p/:token` (`resolveMintSession` in `vet-public-api.yaml`). Non-consuming: never touches
 * `consumed`. Extends the token's `exp` once, on the first successful resolve, so a slow owner
 * does not lose the session to the staff member's original short-lived QR window.
 */
export async function resolveMintSession(
  store: MintFlowStore,
  token: string,
  now: number,
): Promise<ResolveMintSessionResult> {
  const tokenRow = await store.getToken(token);
  if (!tokenRow) return {ok: false, status: 404};

  const consumedPastGrace =
    tokenRow.consumed && tokenRow.consumedAt !== undefined && now > tokenRow.consumedAt + STATUS_GRACE_PERIOD_SECS;
  const naturallyExpired = !tokenRow.consumed && now > tokenRow.exp;
  if (consumedPastGrace || naturallyExpired) return {ok: false, status: 410};

  const session = await store.getSession(tokenRow.sessionId);
  if (!session) return {ok: false, status: 404};

  const exp = await store.extendTtlOnFirstResolve(tokenRow, now, now + RESOLVE_TTL_EXTENSION_SECS);
  return {ok: true, session, ttlSecs: Math.max(0, exp - now)};
}

export type MintSessionStatusResult =
  | {ok: true; status: MintSessionStatus; dogTagIdDec: string; errorStage?: MintErrorStage}
  | {ok: false; status: 404 | 410};

/** `GET /p/:token/status` - answers for `STATUS_GRACE_PERIOD_SECS` past consumption, then 410. */
export async function getMintSessionStatus(
  store: MintFlowStore,
  token: string,
  now: number,
): Promise<MintSessionStatusResult> {
  const tokenRow = await store.getToken(token);
  if (!tokenRow) return {ok: false, status: 404};

  const pastGrace =
    tokenRow.consumed && tokenRow.consumedAt !== undefined && now > tokenRow.consumedAt + STATUS_GRACE_PERIOD_SECS;
  const neverBoundAndExpired = !tokenRow.consumed && now > tokenRow.exp;
  if (pastGrace || neverBoundAndExpired) return {ok: false, status: 410};

  const session = await store.getSession(tokenRow.sessionId);
  if (!session) return {ok: false, status: 404};

  return {ok: true, status: session.status, dogTagIdDec: session.dogTagIdDec, errorStage: session.errorStage};
}

export interface CustodialBindInput {
  token: string;
  root: string;
  leaves: OpenedLeaf[];
  reservedLeafHashes: string[];
}

export type CustodialBindResult =
  | {ok: true; session: MintSessionRow}
  | {ok: false; code: "not_found"}
  // `vet-public-api.yaml` is WIRE-AUTHORITATIVE (this repo's hard rule) and its 409 response is
  // not just a status code but a documented PAYLOAD: "This token was already successfully bound.
  // `error.details.dogTagId` names the existing tag." A 410 cannot carry that detail and still
  // match the spec's schema for this case, so a token that is CONSUMED (bound, successfully or
  // otherwise) - whether this call lost a fresh consume race or the token was already spent -
  // returns `already_bound` with the dogTagId, never `expired_or_reused`. wp4-vet.md's own prose
  // ("second call -> 410") is reconciled by reading it as shorthand for this same reuse case; the
  // yaml's payload-bearing contract is the tiebreaker.
  | {ok: false; code: "already_bound"; dogTagIdDec: string}
  // Reserved for the case the yaml's 410 actually documents: the token was never consumed and its
  // TTL simply lapsed (or the token never existed as a session at all).
  | {ok: false; code: "expired_or_reused"}
  | {ok: false; code: "leaf_commitment_invalid"; sessionId: string}
  | {ok: false; code: "seal_conflict"; sessionId: string}
  // `isRootStillUnset` (`chainRead.ts`'s `isProfileRootUnset`) is deliberately fail-closed: an
  // RPC timeout or a downed node THROWS rather than resolving to a guessed `true`/`false` (see
  // that file's doc comment). By the time this call runs, `tryConsumeToken` above has already
  // succeeded, so a bare rethrow here would escape uncaught past the route handler, wedge the
  // session at `pending` forever (its bind token burned, un-retryable - `error`-only sessions
  // qualify for `/retry`), and answer with a bodyless 500 instead of the yaml's documented
  // `Error`-shaped ServerError. This code exists so the caller can instead mark the session
  // `error`/`seal` (making it immediately retryable with a fresh token) and answer 503 properly.
  | {ok: false; code: "transient_error"; sessionId: string};

/**
 * `POST /profiles/issue/custodial-bind`. Order of operations, all fail-closed (wp4-vet.md issuance
 * step 4, normative):
 * 1. Atomically consume the token - a second call against an already-consumed token never
 *    reaches step 2 again (see `CustodialBindResult`'s `already_bound` doc comment for the
 *    409-vs-410 note).
 * 2. `verifyLeafCommitment` from `@dogtag/standard` - never reimplemented here.
 * 3. Re-read `profileRoot(dogTagIdField)` on chain; only seal if it is STILL unset (guards a
 *    duplicate-id race between this bind and some other issuance for the same handle).
 */
export async function custodialBind(
  store: MintFlowStore,
  input: CustodialBindInput,
  now: number,
  isRootStillUnset: (dogTagIdFieldDec: string) => Promise<boolean>,
): Promise<CustodialBindResult> {
  const tokenRow = await store.getToken(input.token);
  if (!tokenRow) return {ok: false, code: "not_found"};

  if (tokenRow.consumed) {
    const boundSession = await store.getSession(tokenRow.sessionId);
    return {ok: false, code: "already_bound", dogTagIdDec: boundSession?.dogTagIdDec ?? ""};
  }
  if (now > tokenRow.exp) return {ok: false, code: "expired_or_reused"};

  const session = await store.getSession(tokenRow.sessionId);
  if (!session) return {ok: false, code: "not_found"};
  if (session.status !== "pending") {
    return {ok: false, code: "already_bound", dogTagIdDec: session.dogTagIdDec};
  }

  const consumed = await store.tryConsumeToken(input.token, now);
  if (!consumed) {
    // Lost a concurrent consume race - another request already flipped `consumed` between our
    // reads above and this call. Re-fetch so the reported dogTagId reflects whatever that
    // request actually did, not our stale in-memory `session`.
    const raced = await store.getSession(tokenRow.sessionId);
    return {ok: false, code: "already_bound", dogTagIdDec: raced?.dogTagIdDec ?? session.dogTagIdDec};
  }

  const verified = verifyLeafCommitment({
    root: input.root,
    leaves: input.leaves,
    reservedLeafHashes: input.reservedLeafHashes,
    expectedIdentityLeaves: session.identityLeaves,
  });
  if (!verified) {
    await store.markError(session.sessionId, "attestation");
    return {ok: false, code: "leaf_commitment_invalid", sessionId: session.sessionId};
  }

  // The token is already consumed at this point (see above), so from here on ANY unhandled throw
  // - not just a `false` result - must still leave the session in a recoverable state rather than
  // escaping uncaught. `store.markError` below always runs before this function returns, on every
  // path: the on-chain root read failing outright (`catch`), and the read succeeding but reporting
  // the root already set (the pre-existing `seal_conflict` branch).
  let stillUnset: boolean;
  try {
    stillUnset = await isRootStillUnset(session.dogTagIdFieldDec);
  } catch {
    await store.markError(session.sessionId, "seal");
    return {ok: false, code: "transient_error", sessionId: session.sessionId};
  }
  if (!stillUnset) {
    await store.markError(session.sessionId, "seal");
    return {ok: false, code: "seal_conflict", sessionId: session.sessionId};
  }

  await store.commitReady(session, {
    root: input.root,
    boundLeaves: input.leaves,
    reservedLeafHashes: input.reservedLeafHashes,
  });

  return {ok: true, session: {...session, status: "ready", root: input.root}};
}
