import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";
import {randomUUID} from "node:crypto";

export type VerifySessionStatus = "pending" | "proof_received" | "submitting" | "recorded" | "error";

export interface GrothProof {
  a: [string, string];
  b: [[string, string], [string, string]];
  c: [string, string];
  pubSignals: string[]; // exactly 7, pinned order per specs/vet-public-api.yaml
}

export interface ProfileDisclosureEntry {
  keyPath: string;
  saltHex: string;
  tag: number;
  value: string;
  proof: string[];
}

export interface ProfileDisclosure {
  dogTagId: string;
  R: string;
  disclosures: ProfileDisclosureEntry[];
}

export interface VerifySessionDoc {
  sessionId: string;
  /** The 32-lowercase-hex verify-session token from the `/x/<32hex>?a=<relayer>` QR
   * (`specs/qr-formats.md`) - the public lookup key for `GET /x/:token` and this session's own
   * status poll. Distinct from `sessionId` (an internal id never exposed in a URL). */
  token: string;
  relayerAddress: string;
  purpose: string;
  recordType: string;
  challenge: {
    dogTagId: string;
    deadline: number;
    consentNonce: string;
  };
  status: VerifySessionStatus;
  proof?: GrothProof;
  profileDisclosure?: ProfileDisclosure;
  txHash?: string;
  nullifier?: string;
  appointmentId?: string;
  clientId?: string;
  petId?: string;
  disclosedKeyPaths: string[];
  createdAt: Date;
  updatedAt: Date;
}

const grothProofSchema = new Schema<GrothProof>(
  {
    a: {type: [String], required: true},
    b: {type: [[String]], required: true},
    c: {type: [String], required: true},
    pubSignals: {type: [String], required: true},
  },
  {_id: false},
);

const disclosureEntrySchema = new Schema<ProfileDisclosureEntry>(
  {
    keyPath: {type: String, required: true},
    saltHex: {type: String, required: true},
    tag: {type: Number, required: true},
    value: {type: String, required: true},
    proof: {type: [String], required: true},
  },
  {_id: false},
);

const profileDisclosureSchema = new Schema<ProfileDisclosure>(
  {
    dogTagId: {type: String, required: true},
    R: {type: String, required: true},
    disclosures: {type: [disclosureEntrySchema], required: true},
  },
  {_id: false},
);

const verifySessionSchema = new Schema<VerifySessionDoc>(
  {
    sessionId: {type: String, required: true, unique: true, default: () => randomUUID()},
    token: {type: String, required: true, unique: true},
    relayerAddress: {type: String, required: true, index: true},
    purpose: {type: String, required: true},
    recordType: {type: String, required: true},
    challenge: {
      dogTagId: {type: String, required: true},
      deadline: {type: Number, required: true},
      consentNonce: {type: String, required: true},
    },
    status: {
      type: String,
      enum: ["pending", "proof_received", "submitting", "recorded", "error"],
      required: true,
      default: "pending",
      index: true,
    },
    proof: grothProofSchema,
    profileDisclosure: profileDisclosureSchema,
    txHash: String,
    nullifier: {type: String, index: true, sparse: true},
    appointmentId: String,
    clientId: String,
    petId: String,
    disclosedKeyPaths: {type: [String], default: []},
  },
  {timestamps: true},
);

export const VerifySession =
  getOrCreateModel<VerifySessionDoc>("VerifySession", verifySessionSchema);
