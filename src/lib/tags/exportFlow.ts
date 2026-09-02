import {hashLeaf, hexToBytes, scalarFromPacked, toHex32, verifyRedactedArtifact, type TypeTag} from "@dogtag/standard";

/**
 * The pure export-ceremony flow (plans/wp4.9-tag-data-custody.md section 2.2, generalized by
 * WP4.10V item 3 to serve a `RedactedTagArtifact` - plans/wp4.10-masked-export.md section 2) - the
 * flow/store-adapter split every ceremony in this app uses (`lib/registration/flow.ts`,
 * `lib/mint/flow.ts`), so `resolveAndConsumeExport` is unit-testable against an in-memory fake with
 * zero database, including the concurrent-race case a real integration test can only approximate.
 */
export interface ExportSessionRow {
  token: string;
  petId: string;
  root: string; // lowercase
  exp: number; // unix seconds
  /** WP4.10V item 3 - keyPaths staff chose to mask, snapshotted at session-creation time. `[]` (or
   * absent) is an ordinary, fully-disclosed export - see `ArtifactExportSession`'s own doc comment. */
  mask?: string[];
  usedAt?: number;
}

/** The subset of a `TagArtifact` this ceremony reads. Defined here (not imported from
 * `@/lib/models/TagArtifact`) so this module stays free of any mongoose dependency, per this app's
 * flow-module convention. `leaves` is the FULL disclosed-at-custody-time set this clinic actually
 * holds openings for (never padded/guessed); `obfuscatedLeafHashes` is whatever this artifact ITSELF
 * already carries as opaque hashes (non-empty only when this row is itself partial custody from an
 * earlier masked import - WP4.10V item 6) - both are folded together with any NEWLY staff-picked
 * mask below, so an already-partial artifact re-exported with no additional mask still recomputes
 * its root correctly. */
export interface ExportedArtifactRow {
  protocolVersion: string;
  schemaId?: string;
  dogTagIdDec?: string;
  dogTagIdField: string;
  root: string;
  leaves: {keyPath: string; saltHex: string; tag: TypeTag; value: string}[];
  /** Normalized to `[]` by the adapter at its own boundary if genuinely absent (a legacy row -
   * `TagArtifactDoc.obfuscatedLeafHashes`'s own doc comment on why `.lean()` never applies a schema
   * default) - this pure module never has to special-case `undefined` itself. */
  obfuscatedLeafHashes: string[];
  reservedLeafHashes: string[];
  issuerClone: string;
  active: boolean;
}

export interface ExportFlowStore {
  getByToken(token: string): Promise<ExportSessionRow | null>;
  /** Atomically flips `usedAt` from unset to `now` - `false` if the token was already consumed (a
   * concurrent or repeat call lost the race, or already won it). The ONE race-resolving step: every
   * check below this point in `resolveAndConsumeExport` runs only for whichever single caller wins
   * it, so two concurrent scans of the same QR can never both receive the payload. */
  tryConsume(token: string, now: number): Promise<boolean>;
  /** The artifact that was active for `petId` under exactly this `root` - `null` if it no longer
   * exists at all, or exists but `active` has since flipped false (superseded by a later tag). */
  findArtifactByPetAndRoot(petId: string, root: string): Promise<ExportedArtifactRow | null>;
  /** `null` if the pet itself has vanished since the session was created (defensive only). */
  findPetForExport(petId: string): Promise<{name: string; dogTagStatus?: "active" | "revoked"} | null>;
  /** This clinic's configured display name - absent falls back to an empty string in the response
   * rather than failing the export (the ceremony's whole point is the cryptographic payload; a
   * clinic that has not set a display name yet should not lose the ability to export tag data over
   * it, unlike wallet-registration's create-time hard requirement for the SAME field). */
  getClinicName(): Promise<string | undefined>;
}

/** The crypto-bearing subset of a `RedactedTagArtifact` this module ever produces - shared by the
 * ceremony's response (`ExportResult.data`, plus display context) and the staff-only preview/
 * download route (`buildRedactedExportPayload`'s own doc comment), so both surfaces always agree
 * byte-for-byte on what a given (artifact, mask) pair actually exports.
 *
 * CORRECTION (orchestrator ruling, P2 finding): this file originally renamed `leaves` to
 * `disclosed` outright, on the claim that "no shipped consumer parses the old name". That claim
 * was FALSE - WP4.9M (dogtag-ios) ships `ArtifactExportResponse.leaves: [OpenedLeaf]` as a
 * NON-OPTIONAL Codable field (`DogTag/Net/VetAPIModels.swift`) that the real receive/device-
 * recovery screen (`ArtifactReceiveEngine`) already decodes against the live vet server today - a
 * bare rename would have broken that decode entirely (Codable throws on a missing required key)
 * until WP4.10M (the not-yet-built masked-aware phone client) ships. Fixed to an ADDITIVE
 * transition instead: both `leaves` and `disclosed` are served with IDENTICAL content (computed
 * once, never two independently-maintained copies), `leaves` documented as the deprecated alias in
 * the synced spec, to be dropped once WP4.10M lands and every consumer reads `disclosed`. */
export interface RedactedExportData {
  protocolVersion: string;
  schemaId?: string;
  dogTagIdDec?: string;
  dogTagIdField: string;
  root: string;
  /** DEPRECATED alias of `disclosed` (identical content) - kept only because WP4.9M's shipped
   * `ArtifactReceiveEngine` decodes this exact key as non-optional. Never diverges from
   * `disclosed`: both are populated from the same array in `buildRedactedExportPayload`, not two
   * separately-maintained values. Remove once WP4.10M (the masked-aware phone client) ships and
   * every consumer reads `disclosed` instead. */
  leaves: {keyPath: string; saltHex: string; tag: TypeTag; value: string}[];
  /** The UNMASKED openings - plan section 2's `disclosed` field, the same name the registry schema
   * and `@dogtag/standard`'s `RedactedTagArtifact` type both use; the CANONICAL field going
   * forward (`leaves` above is the deprecated alias, not the other way around). */
  disclosed: {keyPath: string; saltHex: string; tag: TypeTag; value: string}[];
  /** Every leaf hash this response withholds the opening for - the union of whatever the artifact
   * ITSELF already carried as opaque (partial custody, item 6) and whatever staff additionally
   * masked for THIS export. `[]` for an ordinary, fully-disclosed export - the exact pre-WP4.10V
   * behavior, still fully supported (and still exactly what WP4.9M's own `leaves`-only decode
   * receives when nothing is masked - this field is simply new information that client does not
   * yet read). */
  obfuscatedLeafHashes: string[];
  reservedLeafHashes: string[];
  issuerClone: string;
}

export type ExportResult =
  | {
      ok: true;
      /** `chainId` is deliberately NOT here - it is a fixed deployment constant (`roax.id`), never
       * a database fact, so the ROUTE splices it into the wire response directly, the same place
       * `POST /api/clients/:id/wallet-registrations` already reads `roax.id` rather than threading
       * it through a store method for a value that never varies per call. */
      data: RedactedExportData & {petName: string; clinicName: string};
    }
  | {ok: false; code: "not_found"}
  | {ok: false; code: "expired_or_reused"}
  | {ok: false; code: "revoked"}
  | {ok: false; code: "superseded"}
  /** The self-check safety net below (never trust the payload we are about to serve without
   * recomputing it) failed - a server BUG, never an owner/staff input problem. The token is already
   * consumed by this point (step 2 already ran, matching every other refusal's one-shot semantics -
   * see this function's own doc comment) - the route logs this loudly and returns 500, not a retry. */
  | {ok: false; code: "internal_error"};

/** Recompute one leaf's hash from its opening, exactly like `@dogtag/standard`'s own
 * `recomputeLeaf` (`redactedArtifact.ts`, `profileBind.ts`) - a second, deliberate transcription
 * composed entirely from already-exported primitives (`hashLeaf`, `scalarFromPacked`,
 * `hexToBytes`, `toHex32`), not a shared import, matching that file's own precedent for why (see
 * its header: any future drift is exactly what a cross-check test would catch). Never trusts a
 * stored hash for a leaf THIS clinic is about to mask - it only ever discloses a leaf's hash by
 * recomputing it fresh from the opening this clinic actually holds. Exported so the field-picker's
 * own listing route (`listExportableFields` below) shares the identical computation, never a
 * second copy that could drift from what `resolveAndConsumeExport` actually serves. */
export function recomputeLeafHash(leaf: {keyPath: string; saltHex: string; tag: TypeTag; value: string}): string {
  const scalar = scalarFromPacked(leaf.tag, leaf.value);
  return toHex32(hashLeaf(leaf.keyPath, hexToBytes(leaf.saltHex), scalar));
}

/** `owner.identity.*` - the one namespace WP4.10S's ruling still treats as conceptually distinct
 * from an ordinary pet attribute for DISPLAY/grouping purposes (item 4's field picker groups "pet
 * attributes" apart from "owner identity"), even though both are equally maskable. Never the
 * reserved owner-CONTROL namespace (`owner.address`/`owner.consentKey`/`owner.secret`) - those are
 * never leaves at all, so they never appear in this listing in the first place. */
const OWNER_IDENTITY_PREFIX = "owner.identity.";

export interface ExportableField {
  keyPath: string;
  tag: TypeTag;
  value: string;
  /** Precomputed server-side - WP4.10V item 4's staff-facing field-picker route serves this so its
   * "use client" component never needs to import `@dogtag/standard` (this repo's own
   * `serverExternalPackages`/cold-client-build hazard, `tag-custody.spec.ts`'s own doc comment) -
   * the live preview becomes a pure client-side value-to-hash swap, no crypto in the browser. */
  leafHash: string;
  group: "pet" | "owner_identity";
}

/**
 * The staff-facing field-picker listing (WP4.10V item 4) - every leaf THIS clinic currently holds
 * an opening for on the active artifact, each with its precomputed leaf hash (what it would become
 * in `obfuscatedLeafHashes` if staff picks it to mask) and its display group. Pure, no I/O - the
 * route wraps this around `findActiveTagArtifact`'s own leaves.
 */
export function listExportableFields(leaves: {keyPath: string; saltHex: string; tag: TypeTag; value: string}[]): ExportableField[] {
  return leaves.map((leaf) => ({
    keyPath: leaf.keyPath,
    tag: leaf.tag,
    value: leaf.value,
    leafHash: recomputeLeafHash(leaf),
    group: leaf.keyPath.startsWith(OWNER_IDENTITY_PREFIX) ? "owner_identity" : "pet",
  }));
}

/**
 * Given an artifact (its full leaves plus whatever it already carries as opaque) and a set of
 * NEWLY staff-picked keyPaths to mask, produces the exact `RedactedTagArtifact`-shaped payload
 * this app ever serves for it - shared by the ceremony (`resolveAndConsumeExport` below) and the
 * staff-only preview/download route (`buildRedactedExportPayload`'s caller in
 * `lib/tags/exportPreview.ts`), so both always agree on what a given (artifact, mask) pair
 * actually exports, never two independently-maintained copies of this logic.
 *
 * Splits `artifact.leaves` into `disclosed` (not in `mask`) and newly-masked (in `mask` - hash
 * RECOMPUTED fresh from the opening via `recomputeLeafHash`, never trusted from storage, opening
 * dropped). Unions the newly-masked hashes with whatever `obfuscatedLeafHashes` the artifact
 * already carried (partial custody, item 6) - a partial-custody artifact re-exported with an EMPTY
 * mask still includes its inherited hashes, never silently drops them.
 *
 * Self-checks the WHOLE result with `verifyRedactedArtifact` before ever returning it - the
 * falsifiable version of "never trusts stored hashes without recomputing from openings". `ok:
 * false` is a server BUG (a genuinely device-built, already-`createTagArtifact`-verified artifact
 * plus a validated mask should never fail to recompute) - every caller refuses rather than serves
 * on this branch.
 */
export function buildRedactedExportPayload(
  artifact: Pick<
    ExportedArtifactRow,
    "protocolVersion" | "schemaId" | "dogTagIdDec" | "dogTagIdField" | "root" | "leaves" | "obfuscatedLeafHashes" | "reservedLeafHashes" | "issuerClone"
  >,
  mask: string[],
): {ok: true; data: RedactedExportData} | {ok: false} {
  const maskedKeyPaths = new Set(mask);
  const disclosed = artifact.leaves.filter((l) => !maskedKeyPaths.has(l.keyPath));
  const newlyMaskedHashes = artifact.leaves.filter((l) => maskedKeyPaths.has(l.keyPath)).map(recomputeLeafHash);
  const obfuscatedLeafHashes = [...artifact.obfuscatedLeafHashes, ...newlyMaskedHashes];

  const verifies = verifyRedactedArtifact({
    protocolVersion: artifact.protocolVersion,
    dogTagIdField: artifact.dogTagIdField,
    root: artifact.root,
    disclosed,
    obfuscatedLeafHashes,
    reservedLeafHashes: artifact.reservedLeafHashes,
    issuerClone: artifact.issuerClone,
  });
  if (!verifies) return {ok: false};

  return {
    ok: true,
    data: {
      protocolVersion: artifact.protocolVersion,
      schemaId: artifact.schemaId,
      dogTagIdDec: artifact.dogTagIdDec,
      dogTagIdField: artifact.dogTagIdField,
      root: artifact.root,
      // `leaves` is the DEPRECATED alias WP4.9M's shipped ArtifactReceiveEngine still requires
      // (non-optional Codable field) - identical content to `disclosed`, computed from the same
      // array, never a second independently-maintained value. See RedactedExportData's own doc
      // comment for the full correction history.
      leaves: disclosed,
      disclosed,
      obfuscatedLeafHashes,
      reservedLeafHashes: artifact.reservedLeafHashes,
      issuerClone: artifact.issuerClone,
    },
  };
}

/**
 * `GET /e/:token` - the export ceremony's ONLY step (no separate resolve/complete split - see
 * `ArtifactExportSession`'s own doc comment for why). Order of operations:
 *
 * 1. Not-found / cheap expired-or-already-used pre-check, BEFORE attempting to consume - avoids
 *    burning a token that was already dead (mirrors `completeRegistration`'s own pre-check).
 * 2. Atomically consume. A lost race is ALSO `expired_or_reused` - indistinguishable from "already
 *    used" by design, exactly like every other ceremony's token lifecycle in this app.
 * 3. ONLY the winner of step 2 reaches here: look up the artifact this session was created for. A
 *    revoked or superseded refusal still burns the token (step 2 already ran) rather than leaving it
 *    open for a retry - the SAME "no /retry, any check needing a fresh per-attempt read is one-shot"
 *    precedent `completeRegistration`'s `signature_invalid` branch already establishes elsewhere in
 *    this app. A revoked-then-reactivated (or re-replaced) tag is reachable again only via a FRESH
 *    session, never by re-presenting the same QR - this is deliberate, not a gap: it keeps this
 *    ceremony's one-shot semantics uniform regardless of WHY a given attempt failed, rather than
 *    special-casing "this failure reason gets a retry, that one doesn't".
 * 4. WP4.10V: split the artifact's `leaves` into `disclosed` (not in `session.mask`) and
 *    newly-masked (in `session.mask` - hash recomputed fresh from the opening, opening dropped).
 *    Union the newly-masked hashes with whatever `obfuscatedLeafHashes` the artifact already
 *    carried (partial custody, item 6) - a partial-custody artifact re-exported with an EMPTY mask
 *    still serves its inherited hashes, never silently drops them.
 * 5. Self-check: run `verifyRedactedArtifact` on the exact payload about to be served, never
 *    trusting the redaction above without recomputing the whole thing one more time end to end -
 *    the falsifiable version of "never trusts stored hashes without recomputing from openings". A
 *    failure here is a server bug (a genuinely device-built, already-`createTagArtifact`-verified
 *    artifact plus a validated mask should never fail to recompute) - refused as `internal_error`
 *    rather than served, even though the token is already spent.
 */
export async function resolveAndConsumeExport(store: ExportFlowStore, token: string, now: number): Promise<ExportResult> {
  const session = await store.getByToken(token);
  if (!session) return {ok: false, code: "not_found"};
  if (session.usedAt !== undefined || now > session.exp) return {ok: false, code: "expired_or_reused"};

  const consumed = await store.tryConsume(token, now);
  if (!consumed) return {ok: false, code: "expired_or_reused"};

  const artifact = await store.findArtifactByPetAndRoot(session.petId, session.root);
  if (!artifact || !artifact.active) return {ok: false, code: "superseded"};

  const pet = await store.findPetForExport(session.petId);
  if (pet?.dogTagStatus === "revoked") return {ok: false, code: "revoked"};

  const built = buildRedactedExportPayload(artifact, session.mask ?? []);
  if (!built.ok) {
    console.error(
      `export-tag-data self-check failed: the redacted payload for petId=${session.petId} root=${artifact.root} did not recompute its own root (mask=${JSON.stringify(session.mask ?? [])}) - refusing to serve it.`,
    );
    return {ok: false, code: "internal_error"};
  }

  const clinicName = await store.getClinicName();
  return {
    ok: true,
    data: {
      ...built.data,
      petName: pet?.name ?? "",
      clinicName: clinicName ?? "",
    },
  };
}
