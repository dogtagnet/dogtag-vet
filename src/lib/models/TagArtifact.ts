import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";
import {randomUUID} from "node:crypto";

/**
 * The canonical, verify-at-write custody record for a DogTag profile tree - plans/
 * wp4.9-tag-data-custody.md section 2.1. Closes G1 (this repo's ONLY typed, non-Mixed store of
 * opened leaves - `MintSession.boundLeaves` stays `Schema.Types.Mixed` for back-compat with
 * whatever it already holds, this collection is the properly-shaped one going forward) and G2
 * (keyed to the pet/root, not archaeology over mint sessions: `lib/tags/artifact.ts`'s
 * `createTagArtifact`/`supersedeActiveArtifactsForPet` are the only writers).
 *
 * NAMING NOTE: `dogTagIdField` here is the DECIMAL STRING of the field element (`dogTagIdField(
 * dogTagIdDec).toString(10)`), the exact same convention `Pet.dogTag.dogTagIdField` and
 * `TagClaimResult.dogTagIdField` (lib/booking/mobileReconcile.ts) already use - NOT the internal
 * `dogTagIdFieldDec` renaming `MintSessionRow` happens to use for the same value. All three name
 * the same decimal string; a hex/bigint form is never stored here.
 *
 * `root` carries a UNIQUE index (one artifact row per on-chain root, ever) - always stored
 * lowercased by the write helper regardless of the input's casing, since `verifyLeafCommitment`
 * itself compares case-insensitively (`root.toLowerCase()`) and an index is only meaningfully
 * unique if equal roots always compare byte-identical as stored.
 */
export type TagArtifactSource = "issued_here" | "imported";

export interface TagArtifactLeaf {
  keyPath: string;
  saltHex: string;
  tag: number;
  value: string;
}

export interface TagArtifactDoc {
  artifactId: string;
  petId: string;
  dogTagIdDec: string;
  dogTagIdField: string;
  root: string;
  protocolVersion: string;
  /** The schema registry `$id` this credential was issued/received against (e.g. `https://
   * dogtag.io/schemas/dog-profile/v1`) - dogtag-protocol/specs/schemas' `$id` convention. Optional:
   * an imported artifact whose sender did not carry one still verifies (schemaId names SHAPE, the
   * leaf-commitment root recompute below never depends on it). */
  schemaId?: string;
  /** STRICT typed leaves - every element shaped exactly like `OpenedLeaf` (`@dogtag/standard`),
   * never a schema-less blob. This is the "standard way to recompute the root from stored data":
   * `verifyLeafCommitment({root, leaves, reservedLeafHashes, ...})`. */
  leaves: TagArtifactLeaf[];
  reservedLeafHashes: string[];
  source: TagArtifactSource;
  issuerClone: string;
  issuedTx?: string;
  /** Unix seconds this artifact's commitment was independently recomputed and confirmed by
   * `createTagArtifact` - never the request's own wall-clock claim. */
  verifiedAt: number;
  /** Exactly one artifact per pet is ever `active: true` at a time (enforced by
   * `supersedeActiveArtifactsForPet`, called before every insert that supersedes a prior tag) -
   * full history retained via `active: false` rows, never deleted. */
  active: boolean;
  supersededByRoot?: string;
  createdAt: Date;
  updatedAt: Date;
}

const tagArtifactLeafSchema = new Schema<TagArtifactLeaf>(
  {
    keyPath: {type: String, required: true},
    saltHex: {type: String, required: true},
    tag: {type: Number, required: true},
    value: {type: String, required: true},
  },
  {_id: false},
);

const tagArtifactSchema = new Schema<TagArtifactDoc>(
  {
    artifactId: {type: String, required: true, unique: true, default: () => randomUUID()},
    petId: {type: String, required: true, index: true},
    dogTagIdDec: {type: String, required: true},
    dogTagIdField: {type: String, required: true, index: true},
    root: {type: String, required: true, unique: true},
    protocolVersion: {type: String, required: true},
    schemaId: String,
    leaves: {type: [tagArtifactLeafSchema], required: true, default: []},
    reservedLeafHashes: {type: [String], required: true, default: []},
    source: {type: String, enum: ["issued_here", "imported"], required: true},
    issuerClone: {type: String, required: true},
    issuedTx: String,
    verifiedAt: {type: Number, required: true},
    active: {type: Boolean, required: true, default: true, index: true},
    supersededByRoot: String,
  },
  {timestamps: true},
);

// The common lookup this collection exists to make cheap (plan 2.1: "the artifact is looked up by
// root/petId, no denormalization to drift") - one pet's currently-active artifact, with no
// collection scan.
tagArtifactSchema.index({petId: 1, active: 1});

export const TagArtifact = getOrCreateModel<TagArtifactDoc>("TagArtifact", tagArtifactSchema);
