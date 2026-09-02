/**
 * The pure export-ceremony flow (plans/wp4.9-tag-data-custody.md section 2.2) - the
 * flow/store-adapter split every ceremony in this app uses (`lib/registration/flow.ts`,
 * `lib/mint/flow.ts`), so `resolveAndConsumeExport` is unit-testable against an in-memory fake with
 * zero database, including the concurrent-race case a real integration test can only approximate.
 */
export interface ExportSessionRow {
  token: string;
  petId: string;
  root: string; // lowercase
  exp: number; // unix seconds
  usedAt?: number;
}

/** The subset of a `TagArtifact` this ceremony ever discloses - deliberately the FULL leaf set
 * (plan 2.2: selective export is out of scope for v1 - a partial leaf set cannot recompute the
 * root, which is the entire point of shipping it at all) plus the reserved owner-control hashes.
 * Defined here (not imported from `@/lib/models/TagArtifact`) so this module stays free of any
 * mongoose dependency, per this app's flow-module convention. */
export interface ExportedArtifactRow {
  protocolVersion: string;
  schemaId?: string;
  dogTagIdDec?: string;
  dogTagIdField: string;
  root: string;
  leaves: {keyPath: string; saltHex: string; tag: number; value: string}[];
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

export type ExportResult =
  | {
      ok: true;
      /** `chainId` is deliberately NOT here - it is a fixed deployment constant (`roax.id`), never
       * a database fact, so the ROUTE splices it into the wire response directly, the same place
       * `POST /api/clients/:id/wallet-registrations` already reads `roax.id` rather than threading
       * it through a store method for a value that never varies per call. */
      data: {
        protocolVersion: string;
        schemaId?: string;
        dogTagIdDec?: string;
        dogTagIdField: string;
        root: string;
        leaves: {keyPath: string; saltHex: string; tag: number; value: string}[];
        reservedLeafHashes: string[];
        issuerClone: string;
        petName: string;
        clinicName: string;
      };
    }
  | {ok: false; code: "not_found"}
  | {ok: false; code: "expired_or_reused"}
  | {ok: false; code: "revoked"}
  | {ok: false; code: "superseded"};

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

  const clinicName = await store.getClinicName();
  return {
    ok: true,
    data: {
      protocolVersion: artifact.protocolVersion,
      schemaId: artifact.schemaId,
      dogTagIdDec: artifact.dogTagIdDec,
      dogTagIdField: artifact.dogTagIdField,
      root: artifact.root,
      leaves: artifact.leaves,
      reservedLeafHashes: artifact.reservedLeafHashes,
      issuerClone: artifact.issuerClone,
      petName: pet?.name ?? "",
      clinicName: clinicName ?? "",
    },
  };
}
