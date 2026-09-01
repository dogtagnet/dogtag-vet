import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";
import {randomUUID} from "node:crypto";
import {microchipSchema} from "@/lib/models/Pet";
import type {MicrochipInfo, WeightEntry} from "@/lib/models/Pet";

export type MintSessionStatus = "pending" | "ready" | "issuing" | "bound" | "error";
export type MintErrorStage = "attestation" | "seal" | "issue" | "verify" | "interrupted";

export interface OwnerIdentity {
  countryOfIdentification?: string;
  identification?: string;
  name?: string;
}

/** A vet-server-generated `owner.identity.*` opening. Salts MUST be generated here, never
 * client-supplied - low-entropy identity values need attester salts (dossier V11, normative). */
export interface IdentityLeaf {
  keyPath: string;
  saltHex: string;
  tag: number;
  value: string;
}

export interface MintProfile {
  species?: string;
  breedVbo?: string;
  breedLabel?: string;
  sex?: "male" | "female" | "unknown";
  neuterStatus?: "intact" | "neutered" | "spayed" | "unknown";
  dateOfBirth?: string;
  weightHistory: WeightEntry[];
}

export interface MintSessionDoc {
  sessionId: string;
  dogTagIdDec: string;
  dogTagIdField: string;
  ownerIdentity: OwnerIdentity;
  identityLeaves: IdentityLeaf[];
  petId?: string;
  petName: string;
  microchip: MicrochipInfo;
  profile: MintProfile;
  status: MintSessionStatus;
  root?: string;
  boundLeaves?: unknown;
  reservedLeafHashes?: string[];
  txHash?: string;
  /** WP4.5 track 3: set when `issueTag`'s transaction is confirmed REVERTED on chain (the proven
   * gas-refund-tail forensic case) - surfaced in the wizard next to the re-enabled Issue button.
   * Cleared on the next successful issue/reconcile (`markSessionBound`) or the next reverted
   * attempt overwrites it with the same message; never accumulates. */
  lastIssueError?: string;
  /** Every `issueTag` tx hash that was submitted for this session and later confirmed reverted -
   * the audit trail `wp4.5-track3-mint-plan.md` calls for ("keep the failed tx hash in a history
   * field ... rather than dropping it silently"), distinct from `txHash` (the CURRENT, live
   * attempt only). */
  failedIssueTxHashes?: string[];
  protocolVersion: string;
  errorStage?: MintErrorStage;
  errorReason?: string;
  tokenExp: number; // unix seconds
  createdAt: Date;
  /** Set the first time `GET /p/:token` resolves this session - distinct from `resolvedAt`
   * (terminal bind/error time) - so the one-time TTL extension in `vet-public-api.yaml`'s
   * `/p/{token}` doc comment ("The first successful resolve extends the session's TTL once") has
   * somewhere to record that it already happened. */
  firstResolvedAt?: Date;
  /** Set by `POST .../tx` the moment the session enters `issuing` - the worker's boot-recovery
   * staleness check (`isMintSessionStale`, `src/lib/mint/reconcile.ts`) measures from THIS, never
   * `createdAt`: a session can sit `pending` for minutes waiting on the owner's phone before ever
   * reaching `issuing`, so `createdAt` would count that ordinary wait against the staleness
   * threshold and could flip a transaction that has been in flight for mere seconds. */
  issuingAt?: Date;
  resolvedAt?: Date;
}

const identityLeafSchema = new Schema<IdentityLeaf>(
  {
    keyPath: {type: String, required: true},
    saltHex: {type: String, required: true},
    tag: {type: Number, required: true},
    value: {type: String, required: true},
  },
  {_id: false},
);

const weightEntrySchema = new Schema<WeightEntry>(
  {
    unit: {type: String, enum: ["kg", "lb"], required: true},
    value: {type: String, required: true},
    measuredOn: {type: String, required: true},
  },
  {_id: false},
);

const mintSessionSchema = new Schema<MintSessionDoc>(
  {
    sessionId: {type: String, required: true, unique: true, default: () => randomUUID()},
    dogTagIdDec: {type: String, required: true, index: true},
    dogTagIdField: {type: String, required: true, index: true},
    ownerIdentity: {
      countryOfIdentification: String,
      identification: String,
      name: String,
    },
    identityLeaves: {type: [identityLeafSchema], default: []},
    petId: {type: String, index: true},
    petName: {type: String, required: true},
    microchip: {type: microchipSchema, default: () => ({})},
    profile: {
      species: String,
      breedVbo: String,
      breedLabel: String,
      sex: {type: String, enum: ["male", "female", "unknown"]},
      neuterStatus: {type: String, enum: ["intact", "neutered", "spayed", "unknown"]},
      dateOfBirth: String,
      weightHistory: {type: [weightEntrySchema], default: []},
    },
    status: {
      type: String,
      enum: ["pending", "ready", "issuing", "bound", "error"],
      required: true,
      default: "pending",
      index: true,
    },
    root: String,
    boundLeaves: Schema.Types.Mixed,
    reservedLeafHashes: {type: [String], default: undefined},
    txHash: String,
    lastIssueError: String,
    failedIssueTxHashes: {type: [String], default: undefined},
    protocolVersion: {type: String, required: true, default: "dogtag-v2/1"},
    errorStage: {type: String, enum: ["attestation", "seal", "issue", "verify", "interrupted"]},
    errorReason: String,
    tokenExp: {type: Number, required: true},
    firstResolvedAt: Date,
    issuingAt: Date,
    resolvedAt: Date,
  },
  {timestamps: {createdAt: true, updatedAt: false}},
);

export const MintSession =
  getOrCreateModel<MintSessionDoc>("MintSession", mintSessionSchema);
