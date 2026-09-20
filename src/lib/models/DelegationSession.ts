import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";

/**
 * WP4.15 multi-owner (PLANNED - `DelegationRegistry`/`VetIssuer.addSecondaryOwner` are not
 * deployed on any real chain yet). One `POST /api/pets/:id/delegations` ceremony session -
 * mirrors `WalletRegistrationSession` (one document per one-time token, no separate `MintSession`/
 * `BindToken` split, since there is no `/retry` endpoint for either ceremony this model backs).
 *
 * Covers BOTH halves of `docs/DELEGATION.md` section 4's ceremony in one collection, distinguished
 * by `kind`:
 * - `"add"` (section 4.3): the secondary owner's OWN device scans a QR, derives its own delegate
 *   key, and signs a `DelegationClaim` - the full `pending -> claimed -> submitting -> confirmed`
 *   arc, with a PUBLIC `/d/:token` resolve/complete/status surface the phone calls directly.
 * - `"revoke"` (section 4.5): needs "no participation from the secondary owner's own device -
 *   there is nothing for them to sign" and "has no QR of its own... no public API surface"
 *   (`specs/qr-formats.md` "Delegation session QR"). A revoke session is therefore created
 *   already `"claimed"` (the `commitment` being removed is already known - copied from the add
 *   session that originally granted it), skipping `"pending"` entirely, and its `token` is never
 *   exposed through any public route (`/d/:token` resolve/complete both scope their lookup to
 *   `kind: "add"` - see `src/lib/delegation/flow.ts` - so a revoke session's token can never
 *   resolve there even if somehow guessed).
 *
 * `status` is a NEUTRAL internal vocabulary shared by both kinds, deliberately NOT the public
 * `DelegationSessionStatus` wire enum (`specs/vet-public-api.yaml`:
 * `[pending, claimed, adding, added, error]`) - persisting the wire enum's `"added"` on a
 * `kind: "revoke"` session that just had a secondary REMOVED would be exactly the kind of false
 * status string this app's other ceremonies are graded against (WP4.5's own "never a false
 * accusation" lesson, `lib/registration/flow.ts`'s `outcome` doc comment). `GET /d/:token/status`
 * (add-only, by construction) is the ONE place internal `"submitting"/"confirmed"` map onto the
 * wire's `"adding"/"added"` - see that route's own doc comment.
 *
 * `clinic`/`chainId`/`clinicName`/`maskedTargetName`/`dogTagIdField`/`dogTagIdDec` are all
 * snapshotted at creation (never re-read live from `ClinicSettings`/`Client`/`Pet` on resolve) -
 * same rationale as `WalletRegistrationSession`'s own doc comment. `petName` is the one exception,
 * per `specs/vet-public-api.yaml`'s `DelegationSessionChallengeResponse.petName`: "read live, not
 * snapshotted at session creation" - so it is NOT a field on this document at all; `GET /d/:token`
 * reads `Pet.name` fresh every time.
 */
export type DelegationKind = "add" | "revoke";

/** Internal-neutral vocabulary (see this file's own doc comment for why it is not the public wire
 * enum). `"pending"` applies to `kind: "add"` only - a `"revoke"` session starts at `"claimed"`. */
export type DelegationInternalStatus = "pending" | "claimed" | "submitting" | "confirmed" | "error";

export interface DelegationSessionDoc {
  token: string; // 32 lowercase hex, unique - specs/qr-formats.md. Never publicly resolvable for kind:"revoke".
  registrationId: string; // uuid v4, unique
  kind: DelegationKind;
  petId: string; // index - this app's own pet identifier, never sent to the phone
  dogTagIdField: string; // canonical on-chain dogTagId, decimal string, snapshotted
  dogTagIdDec?: string; // this clinic's own decimal handle, snapshotted, when known
  clientId: string; // the secondary owner's (or, for revoke, the being-removed secondary's) client record
  clinic: string; // this clinic's VetIssuer clone address, lowercase 0x hex, snapshotted
  chainId: number; // snapshotted
  clinicName: string; // snapshotted
  maskedTargetName: string; // snapshotted - never the raw name (masked the same way /w does)
  /** `Poseidon2(Ax, Ay)` over the delegate's per-tag consent public key (`docs/DELEGATION.md`
   * section 4.2) - populated by `POST /d/:token/complete` for `kind: "add"`, and copied from the
   * target secondary's own add-session at creation time for `kind: "revoke"` (staff already know
   * which commitment they are removing - it is not something a revoke ceremony discovers). */
  commitment?: string; // 0x hex32
  /** The wallet that signed the `DelegationClaim` (`kind: "add"` only, set alongside `commitment`
   * at `/complete`) - lowercase 0x hex, ALWAYS one of `clientId`'s already-registered wallets
   * (verified before this is ever written; see `src/lib/delegation/flow.ts`). */
  wallet?: string;
  /** Unix seconds, server-stamped at session creation - the `DelegationClaim` struct's `issuedAt`
   * for `kind: "add"`; present but not cryptographically load-bearing for `kind: "revoke"`. */
  issuedAt: number;
  /** The ROAX head block number at session creation, server-fetched (session creation fails
   * closed if the RPC is unreachable) for `kind: "add"` ONLY - the struct's `blockNumber`. A
   * `kind: "revoke"` session signs nothing, so nothing needs a block number; left `undefined`
   * rather than paying for a chain read with no cryptographic purpose. */
  blockNumber?: number;
  deadline: number; // unix seconds - DELEGATION_SESSION_TTL_SECS (600) after issuedAt, both kinds
  status: DelegationInternalStatus;
  /** A device-safe sentence explaining `status: "error"` - never a raw chain error or stack trace,
   * mirroring `MintSession.lastIssueError`'s own contract. Absent for every other status. */
  errorReason?: string;
  /** The `addSecondaryOwner`/`revokeSecondaryOwner` transaction hash, once the operator wallet has
   * submitted it (`status` moves to `"submitting"` at the same time this is set). */
  txHash?: string;
  /** Unix seconds, stamped when `status` first moves to `"submitting"` - what
   * `src/lib/delegation/bootRecovery.ts` measures staleness from (mirrors `MintSession.issuingAt`'s
   * own doc comment: "a seconds-old in-flight transaction from a process that is still very much
   * alive must be left alone" - `createdAt` would be wrong here for the identical reason). */
  submittingAt?: number;
  /** `DelegationRegistry.secondaryCount`/`delegationRoot` read at the moment `status` moved to
   * `"confirmed"` - audit trail only, never the decisive check (`src/lib/delegation/reconcile.ts`'s
   * own doc comment: a concurrent, unrelated write on the same tag can move either value for
   * reasons that have nothing to do with THIS session's own commitment). */
  secondaryCountAtConfirm?: number;
  delegationRootAtConfirm?: string;
  /** The public one-shot gate `GET /d/:token`/`POST /d/:token/complete` enforce (`kind: "add"`
   * only, in practice - see this file's own doc comment on why `kind: "revoke"` never exposes a
   * public route to consume in the first place). Set `true` immediately at creation for
   * `kind: "revoke"` (never `"pending"`, so there is no unconsumed window to begin with) and by
   * `completeDelegationClaim` for `kind: "add"`, on every outcome (success or refusal alike),
   * mirroring `WalletRegistrationSession.consumed`. */
  consumed: boolean;
  consumedAt?: number;
  createdAt: Date;
}

const delegationSessionSchema = new Schema<DelegationSessionDoc>(
  {
    token: {type: String, required: true, unique: true},
    registrationId: {type: String, required: true, unique: true},
    kind: {type: String, enum: ["add", "revoke"], required: true},
    petId: {type: String, required: true, index: true},
    dogTagIdField: {type: String, required: true, index: true},
    dogTagIdDec: String,
    clientId: {type: String, required: true, index: true},
    clinic: {type: String, required: true},
    chainId: {type: Number, required: true},
    clinicName: {type: String, required: true},
    maskedTargetName: {type: String, required: true},
    commitment: {type: String, index: true},
    wallet: String,
    issuedAt: {type: Number, required: true},
    blockNumber: Number,
    deadline: {type: Number, required: true},
    status: {type: String, enum: ["pending", "claimed", "submitting", "confirmed", "error"], required: true},
    errorReason: String,
    txHash: String,
    submittingAt: Number,
    secondaryCountAtConfirm: Number,
    delegationRootAtConfirm: String,
    consumed: {type: Boolean, required: true, default: false},
    consumedAt: Number,
  },
  {timestamps: {createdAt: true, updatedAt: false}},
);

export const DelegationSession =
  getOrCreateModel<DelegationSessionDoc>("DelegationSession", delegationSessionSchema);
