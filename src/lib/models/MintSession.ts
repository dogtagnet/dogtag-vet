import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";
import {randomUUID} from "node:crypto";
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
    microchip: {
      code: String,
      standard: {type: String, enum: ["ISO11784", "ISO11785", "FDX-B", "other"]},
      implantDate: String,
      bodyLocation: String,
    },
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
    protocolVersion: {type: String, required: true, default: "dogtag-v2/1"},
    errorStage: {type: String, enum: ["attestation", "seal", "issue", "verify", "interrupted"]},
    errorReason: String,
    tokenExp: {type: Number, required: true},
    firstResolvedAt: Date,
    resolvedAt: Date,
  },
  {timestamps: {createdAt: true, updatedAt: false}},
);

export const MintSession =
  getOrCreateModel<MintSessionDoc>("MintSession", mintSessionSchema);
