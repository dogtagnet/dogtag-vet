import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";
import {randomUUID} from "node:crypto";
import type {IssuerAttestation} from "@/lib/models/Pet";

/**
 * The custody record for a vaccination (WP4.14) `RecordArtifact` - the sibling of `TagArtifact.ts`
 * (plans/wp4.9-tag-data-custody.md section 2.1), built over `@dogtag/standard`'s `RecordArtifact`
 * wire shape (`recordArtifact.ts`, specs/leaf-commitment.md section 16) instead of
 * `RedactedTagArtifact`. Plan section 11.2 item V1.
 *
 * THE ONE INVARIANT THIS COLLECTION DOES *NOT* SHARE WITH `TagArtifact`: there is no "exactly one
 * active row per pet" rule here. A pet has MANY records over its life (one row per vaccination
 * event), each with its OWN independent lifecycle - never one superseding another the way a
 * replacement tag supersedes the tag it replaces. `active`/`supersededByRoot` from `TagArtifact`
 * have no equivalent here; `status` alone (below) carries a row's whole lifecycle.
 *
 * `root` is required and unique from the moment a row is created (`status: "draft"`), unlike a
 * `MintSession`, which starts with no root at all: `lib/records/build.ts`'s leaf builder computes
 * the full leaf set and root SERVER-SIDE, synchronously, from the issuance form - there is no
 * separate owner-device "bind" ceremony for a record (it carries no owner-control leaves to bind -
 * specs/leaf-commitment.md section 16), so the root exists before any chain write is ever
 * attempted, not after one confirms.
 *
 * `chain.*` starts empty on a fresh draft and fills in as the issuance flow (plan section 11.2 V3)
 * progresses: `contract`/`operator`/`chainId` are stamped from the SAME values already folded into
 * the `issuer.*` leaves (never a second, independently-editable copy - `lib/records/build.ts` is
 * the one place both are ever set, from the one context object); `txHash` on `POST
 * /api/records/:id/tx`; `blockNumber`/`blockTime`/`issuedAt` only once `POST
 * /api/records/:id/confirm` has independently re-read the chain and agreed (a receipt is not proof
 * - the same rule `lib/mint/reconcile.ts`'s own doc comment states for tags).
 */
export type RecordArtifactType = "VACCINATION";

export type RecordArtifactStatus = "draft" | "issuing" | "active" | "revoked" | "error";

/** Mirrors `MintErrorStage`'s narrower shape (`MintSession.ts`) - a record's issuance has no
 * `"attestation"`/`"seal"` stage of its own (no custodial-bind leaf-commitment check exists for a
 * record - the server itself builds and already trusts the leaves it just built): `"verify"` is
 * `POST /api/records/:id/confirm` finding the chain does not (yet, or ever) agree; `"interrupted"`
 * is the worker's boot recovery giving up on a stale `"issuing"` row it could neither reconcile nor
 * prove reverted (`lib/records/bootRecovery.ts`, mirroring `MintErrorStage`'s own `"interrupted"`). */
export type RecordErrorStage = "verify" | "interrupted";

export interface RecordArtifactLeaf {
  keyPath: string;
  saltHex: string;
  tag: number;
  value: string;
}

/** One entry of the record's UNCOMMITTED `conformsTo` block (specs/leaf-commitment.md section 16)
 * - never hashed, never checked by `verifyRecordArtifact`. `standard`/`version` name an entry in
 * the vendored `specs/standards/index.yaml` registry. */
export interface RecordConformsTo {
  standard: string;
  version: string;
}

/**
 * Display/indexing cache of facts ALSO folded into this record's own disclosed `issuer.*` leaves
 * (`issuer.chainId`/`issuer.contract`/`issuer.operator`) plus the on-chain anchoring metadata that
 * has no leaf counterpart at all (`txHash`/`blockNumber`/`blockTime` - specs/leaf-commitment.md
 * section 16's "uncommitted block"). Never the SOURCE of truth for the leaves themselves - a
 * verifier reads the leaves, never this struct - but a convenient, always-consistent-by-construction
 * mirror of them (stamped from the exact same context `lib/records/build.ts` used to build the
 * leaves in the first place, never edited independently afterward).
 */
export interface RecordChainInfo {
  chainId?: number;
  contract?: string;
  operator?: string;
  txHash?: string;
  blockNumber?: number;
  blockTime?: Date;
  /** When `POST /api/records/:id/confirm` independently confirmed this record's anchor - distinct
   * from `RecordArtifactDoc.updatedAt`, which also moves on an unrelated edit (a revoke, say). */
  issuedAt?: Date;
}

export interface RecordArtifactDoc {
  recordId: string;
  petId: string;
  /** Decimal-string convention throughout this app - see `TagArtifact.ts`'s own doc comment. Not
   * itself a leaf (a record's identity leaf is `credentialSubject.dogTagId`, keyed on the pet's
   * on-chain id in the SAME decimal-string convention) but carried here for the same "every call
   * site already has a real value, never a placeholder" reason `CreateTagArtifactInput` documents. */
  dogTagIdField: string;
  recordType: RecordArtifactType;
  /** e.g. `https://dogtag.io/schemas/vaccination/v1` - mirrors the disclosed `credentialSchema.id`
   * leaf (non-maskable; `verifyRecordArtifact` cross-checks the two, when both are present on the
   * wire artifact - specs/leaf-commitment.md section 16's "step 3b"). */
  schemaId: string;
  /** Mirrors the disclosed `credentialSchema.version` leaf. */
  schemaVersion: string;
  protocolVersion: string;
  /** Unique from the moment this row is created - see this file's own header comment. Always
   * lowercase, matching `TagArtifact.root`'s own storage convention. */
  root: string;
  /** The FULL leaf set (every field the issuance form collected - see `lib/records/build.ts`),
   * server-generated salts. This wave's issuance flow never creates a row with anything already
   * masked - masking only ever happens downstream, at EXPORT time (plan section 11.2 V5), which
   * reads this full set and produces a REDUCED payload; it never mutates this row. */
  leaves: RecordArtifactLeaf[];
  /**
   * Always `[]` for every row this wave's issuance flow (V3) creates. Present, like
   * `TagArtifact.obfuscatedLeafHashes`, only so this row's shape stays capable of representing a
   * genuinely partial-custody record, should a future wave add a record IMPORT ceremony
   * (`verifyRecordArtifact`'s own signature already supports it - specs/leaf-commitment.md section
   * 16) - not exercised by anything in this wave.
   */
  obfuscatedLeafHashes?: string[];
  /** Snapshot, at creation time, of `RECORD_NON_MASKABLE_KEY_PATHS` (`@dogtag/standard`) - which
   * seven keyPaths were locked non-maskable for THIS row, at the moment it was issued. A snapshot,
   * not a live re-read of the constant, for the same reason `MintSessionRow.identityLeaves` is a
   * snapshot rather than re-derived: if a future protocol version ever changes the non-maskable set,
   * a record issued under an earlier policy keeps the rule it was actually issued under, rather than
   * silently being re-judged against a rule that did not exist yet at issuance time. */
  nonMaskable: string[];
  status: RecordArtifactStatus;
  chain: RecordChainInfo;
  /** UNCOMMITTED (specs/leaf-commitment.md section 16) - `[]` is a valid, common value (no claimed
   * external-standard conformance yet). */
  conformsTo: RecordConformsTo[];
  /** The C3 EIP-712 issuer attestation for THIS record (`recordType` = `"VACCINATION"`, not
   * `RECORD_TYPE_PROFILE`) - same shape `Pet.dogTag.attestation` already uses (`Pet.ts`'s own
   * `IssuerAttestation`, reused verbatim rather than a second, drift-prone copy of the same fields).
   * Absent until the operator wallet actually signs it (plan section 11.2 V3's last step). */
  attestation?: IssuerAttestation;
  revokedAt?: Date;
  /** A `ReasonCodeName` (`lib/reasonCodes.ts`) - the same reason-code table `revokeTag` already
   * uses, not a second, independently-maintained list. */
  revokedReason?: string;
  errorStage?: RecordErrorStage;
  /** Stamped by `POST /api/records/:id/tx` the moment `status` first enters `"issuing"` - the
   * worker boot-recovery staleness clock measures from THIS, never `createdAt` (a draft can sit
   * unsent for minutes while the vet fills the form) and never `updatedAt` (which also moves on an
   * unrelated later edit, e.g. a revoke) - the identical `issuingAt`-not-`createdAt` reasoning
   * `MintSessionDoc.issuingAt`'s own doc comment gives for tags. */
  issuingAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const recordArtifactLeafSchema = new Schema<RecordArtifactLeaf>(
  {
    keyPath: {type: String, required: true},
    saltHex: {type: String, required: true},
    tag: {type: Number, required: true},
    value: {type: String, required: true},
  },
  {_id: false},
);

const recordConformsToSchema = new Schema<RecordConformsTo>(
  {
    standard: {type: String, required: true},
    version: {type: String, required: true},
  },
  {_id: false},
);

const recordChainInfoSchema = new Schema<RecordChainInfo>(
  {
    chainId: Number,
    contract: String,
    operator: String,
    txHash: String,
    blockNumber: Number,
    blockTime: Date,
    issuedAt: Date,
  },
  {_id: false},
);

/** Mirrors `Pet.ts`'s own `issuerAttestationSchema` field-for-field (the two never share a single
 * schema object across two different top-level Mongoose models, but both are written from - and
 * typed against - the exact same `IssuerAttestation` interface, so they can never structurally
 * drift from each other). */
const recordAttestationSchema = new Schema<IssuerAttestation>(
  {
    domain: {
      name: {type: String, required: true},
      version: {type: String, required: true},
      chainId: {type: Number, required: true},
      verifyingContract: {type: String, required: true},
    },
    message: {
      merkleRoot: {type: String, required: true},
      recordType: {type: String, required: true},
      issuerContract: {type: String, required: true},
      issuerName: {type: String, required: true},
      issuerDomain: {type: String, required: true},
    },
    signature: {type: String, required: true},
    issuerSigner: {type: String, required: true},
  },
  {_id: false},
);

const recordArtifactSchema = new Schema<RecordArtifactDoc>(
  {
    recordId: {type: String, required: true, unique: true, default: () => randomUUID()},
    petId: {type: String, required: true, index: true},
    dogTagIdField: {type: String, required: true, index: true},
    recordType: {type: String, enum: ["VACCINATION"], required: true},
    schemaId: {type: String, required: true},
    schemaVersion: {type: String, required: true},
    protocolVersion: {type: String, required: true},
    root: {type: String, required: true, unique: true},
    leaves: {type: [recordArtifactLeafSchema], required: true, default: []},
    obfuscatedLeafHashes: {type: [String], required: true, default: []},
    nonMaskable: {type: [String], required: true, default: []},
    status: {
      type: String,
      enum: ["draft", "issuing", "active", "revoked", "error"],
      required: true,
      default: "draft",
      index: true,
    },
    chain: {type: recordChainInfoSchema, required: true, default: () => ({})},
    conformsTo: {type: [recordConformsToSchema], required: true, default: []},
    attestation: recordAttestationSchema,
    revokedAt: Date,
    revokedReason: String,
    errorStage: {type: String, enum: ["verify", "interrupted"]},
    issuingAt: Date,
  },
  {timestamps: true},
);

// The common lookup this collection exists to make cheap: every record for one pet, newest first
// (the Records tab's own list query) - plan section 11.2 V4.
recordArtifactSchema.index({petId: 1, createdAt: -1});

export const RecordArtifact = getOrCreateModel<RecordArtifactDoc>("RecordArtifact", recordArtifactSchema);
