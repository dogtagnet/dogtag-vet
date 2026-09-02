import type {OpenedLeaf} from "@dogtag/standard";
import {createTagArtifact, type CreateTagArtifactResult} from "@/lib/tags/artifact";
import {MintSession} from "@/lib/models/MintSession";

/** The record type dogtag-vet's mint flow issues today - `MintProfile` (species/breedVbo/
 * breedLabel/sex/neuterStatus/dateOfBirth/weightHistory) structurally corresponds to exactly this
 * one record type in the schema registry (dogtag-protocol/specs/schemas/dogtag.dog-profile.v1.
 * schema.json's `$id`). Hardcoded rather than dispatched: this app has no OTHER record-issuing path
 * through custodial-bind (a vaccination/service-attestation record, if this app ever issues one,
 * would be a separate root/tree via a separate flow, not this one) - see wp4.9V-progress.md's LOG
 * for the full reasoning and the honest limit this implies (no live registry validation happens
 * here; this is a pointer, not a fetched-and-checked schema). */
const DOG_PROFILE_SCHEMA_ID = "https://dogtag.io/schemas/dog-profile/v1";

export interface IssuedArtifactSideEffectStore {
  createTagArtifact(input: {
    petId: string;
    dogTagIdDec: string;
    dogTagIdField: string;
    root: string;
    leaves: OpenedLeaf[];
    reservedLeafHashes: string[];
    expectedIdentityLeaves: OpenedLeaf[];
    issuerClone: string;
    now: number;
  }): Promise<CreateTagArtifactResult>;
  /** Best-effort flag - see `applyIssuedArtifactSideEffect`'s own doc comment for why a failure to
   * flag must never itself throw back into the caller. */
  flagArtifactError(sessionId: string): Promise<void>;
}

export const mongoIssuedArtifactStore: IssuedArtifactSideEffectStore = {
  createTagArtifact: (input) =>
    createTagArtifact({
      ...input,
      protocolVersion: "dogtag-v2/1",
      schemaId: DOG_PROFILE_SCHEMA_ID,
      source: "issued_here",
    }),
  async flagArtifactError(sessionId) {
    await MintSession.updateOne({sessionId}, {$set: {artifactError: true}});
  },
};

export interface ApplyIssuedArtifactSideEffectInput {
  sessionId: string;
  /** Absent only if a MintSession was somehow created without one - `api/tags/issue/start/route.ts`
   * always sets one, so this is defensive, not an expected path. */
  petId?: string;
  dogTagIdDec: string;
  dogTagIdField: string;
  root: string;
  leaves: OpenedLeaf[];
  reservedLeafHashes: string[];
  /** The vet-attested `owner.identity.*` openings (`MintSessionRow.identityLeaves`) - a REAL
   * cross-check here, unlike the imported-artifact side effects' self-check (this is exactly what
   * `custodialBind` itself already verified moments earlier with these same values). */
  identityLeaves: OpenedLeaf[];
  /** Absent only if the clinic's clone address somehow became unconfigured between session start
   * (where `preflightIssuance` already required one) and this bind landing - defensive, not an
   * expected path. */
  issuerClone?: string;
  now: number;
}

/**
 * The custodial-bind terminal write's TagArtifact side effect (plan section 2.1/checklist item
 * 3a) - "artifact AFTER the session bind lands, failure flagged not thrown, mirroring postBooking's
 * contract" (`lib/booking/postBooking.ts`'s `applyPostBookingSideEffects`, the house pattern for
 * exactly this shape: the PRIMARY write - here, `custodialBind`'s session bind - is already durable
 * by the time this runs, so a throw here must never surface as a 500 to an owner's phone that just
 * successfully bound its tag). Any failure is caught, logged, and best-effort flagged
 * (`MintSession.artifactError`) - never re-thrown - and the caller always proceeds to its own
 * success response regardless.
 */
export async function applyIssuedArtifactSideEffect(
  store: IssuedArtifactSideEffectStore,
  input: ApplyIssuedArtifactSideEffectInput,
): Promise<{completed: boolean}> {
  try {
    if (!input.petId) {
      throw new Error("mint session has no petId - cannot attach a TagArtifact");
    }
    if (!input.issuerClone) {
      throw new Error("clinic has no configured clone address - cannot attach a TagArtifact");
    }
    const result = await store.createTagArtifact({
      petId: input.petId,
      dogTagIdDec: input.dogTagIdDec,
      dogTagIdField: input.dogTagIdField,
      root: input.root,
      leaves: input.leaves,
      reservedLeafHashes: input.reservedLeafHashes,
      expectedIdentityLeaves: input.identityLeaves,
      issuerClone: input.issuerClone,
      now: input.now,
    });
    if (!result.ok) {
      throw new Error(`createTagArtifact refused the issued_here artifact: ${result.reason}`);
    }
    return {completed: true};
  } catch (err) {
    console.error(`custodial-bind artifact side effect failed for session ${input.sessionId}:`, err);
    try {
      await store.flagArtifactError(input.sessionId);
    } catch (flagErr) {
      console.error(`could not flag session ${input.sessionId} for artifact-write review:`, flagErr);
    }
    return {completed: false};
  }
}
