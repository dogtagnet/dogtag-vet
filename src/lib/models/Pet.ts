import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";
import {randomUUID} from "node:crypto";

export type PetSex = "male" | "female" | "unknown";
export type DogTagStatus = "active" | "revoked";

export interface WeightEntry {
  unit: "kg" | "lb";
  value: string; // decimal string - never a native float, per protocol amount convention
  measuredOn: string; // ISO date
}

export interface MicrochipInfo {
  code?: string;
  standard?: "ISO11784" | "ISO11785" | "FDX-B" | "other";
  implantDate?: string;
  bodyLocation?: string;
}

/** The C3 EIP-712 issuer attestation (`protocol/specs/issuer-attestation.md`), signed by the
 * operator wallet immediately after `issueTag` confirms. Stored verbatim (domain + message +
 * signature) so an offline verifier can recover the signer without any further chain read -
 * see the spec's "How verifiers check it". Never a leaf - this sits outside the Merkle root R,
 * exactly like the spec documents. */
export interface IssuerAttestation {
  domain: {name: string; version: string; chainId: number; verifyingContract: string};
  message: {
    merkleRoot: string;
    recordType: string;
    issuerContract: string;
    issuerName: string;
    issuerDomain: string;
  };
  signature: string;
  issuerSigner: string;
}

export interface DogTagInfo {
  dogTagIdDec?: string;
  dogTagIdField?: string;
  root?: string;
  status?: DogTagStatus;
  issuedTx?: string;
  cloneAddress?: string;
  attestation?: IssuerAttestation;
  /** When this tag was bound (the confirm route's or the reconcile path's terminal write) -
   * distinct from `Pet.updatedAt`, which also moves on an unrelated edit (name, notes, ...) and so
   * cannot serve as "issued date" for the `/tags` table. Absent on any pet issued before this
   * field existed. */
  issuedAt?: Date;
  /** WP4.4 Q3: `true` for a provisional pet record imported from an EXTERNAL clinic's tag claim
   * during mobile booking (section 3, tier 4) - the tag verified on chain (issuer identified,
   * valid) AND the booking's raw pet data verified against the on-chain root, but this clinic
   * never issued it. Excludes the record from this clinic's own tags/issuance surfaces (`/tags`,
   * `/tags/issue`): it is not a tag this clinic can revoke, reactivate, or claim credit for
   * issuing. Absent (never `false`) on every pet this clinic actually issued or has not yet tagged
   * - the field only ever exists to mark the one case it's true for. */
  external?: boolean;
  /** WP4.9 import ceremony: fields where the target pet ALREADY had a value that differed from
   * what this tag's verified data claimed - the fill-empty-only merge (section 2.3) never
   * overwrites staff-entered data, so these are surfaced for staff review rather than applied.
   * Explicitly point-in-time (`detectedAt`) rather than a live-recomputed fact: if staff later
   * edit a field to match the verified value, this array is NOT automatically cleared or
   * recomputed (there is no trigger that would do so), so the pet page must present it as
   * "at import time", never as a current-state claim - a stale copy of this banner asserted as
   * present-tense would be exactly the kind of untruthful signal this app's own MAJOR-2 lesson
   * (`models/Availability.ts`'s own doc comment) warns against repeating. Cleared implicitly
   * only when `dogTag` itself is replaced wholesale (a fresh import or a new issuance overwrites
   * the entire `dogTag` subdocument, this field included). Absent when the last import had no
   * conflicts, or when this tag was never imported at all. */
  importConflicts?: {
    detectedAt: number; // unix seconds
    fields: {field: string; petValue: string; verifiedValue: string}[];
  };
}

export interface PetDoc {
  petId: string;
  name: string;
  species?: string;
  breed?: string;
  sex?: PetSex;
  dateOfBirth?: string;
  notes?: string;
  microchip: MicrochipInfo;
  weightHistory: WeightEntry[];
  ownerClientIds: string[];
  dogTag: DogTagInfo;
  photoFileId?: string;
  searchKey: string;
  createdAt: Date;
  updatedAt: Date;
}

const weightEntrySchema = new Schema<WeightEntry>(
  {
    unit: {type: String, enum: ["kg", "lb"], required: true},
    value: {type: String, required: true},
    measuredOn: {type: String, required: true},
  },
  {_id: false},
);

export const microchipSchema = new Schema<MicrochipInfo>(
  {
    code: String,
    standard: {type: String, enum: ["ISO11784", "ISO11785", "FDX-B", "other"]},
    implantDate: String,
    bodyLocation: String,
  },
  {_id: false},
);

const issuerAttestationSchema = new Schema<IssuerAttestation>(
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

const importConflictFieldSchema = new Schema(
  {
    field: {type: String, required: true},
    petValue: {type: String, required: true},
    verifiedValue: {type: String, required: true},
  },
  {_id: false},
);

const importConflictsSchema = new Schema(
  {
    detectedAt: {type: Number, required: true},
    fields: {type: [importConflictFieldSchema], required: true, default: []},
  },
  {_id: false},
);

const dogTagSchema = new Schema<DogTagInfo>(
  {
    dogTagIdDec: {type: String, index: true},
    dogTagIdField: {type: String, index: true},
    root: String,
    status: {type: String, enum: ["active", "revoked"]},
    issuedTx: String,
    cloneAddress: String,
    attestation: issuerAttestationSchema,
    issuedAt: Date,
    external: Boolean,
    importConflicts: importConflictsSchema,
  },
  {_id: false},
);

const petSchema = new Schema<PetDoc>(
  {
    petId: {type: String, required: true, unique: true, default: () => randomUUID()},
    name: {type: String, required: true, trim: true},
    species: String,
    breed: String,
    sex: {type: String, enum: ["male", "female", "unknown"]},
    dateOfBirth: String,
    notes: String,
    microchip: {type: microchipSchema, default: () => ({})},
    weightHistory: {type: [weightEntrySchema], default: []},
    ownerClientIds: {type: [String], default: [], index: true},
    dogTag: {type: dogTagSchema, default: () => ({})},
    photoFileId: String,
    searchKey: {type: String, required: true, index: true},
  },
  {timestamps: true},
);

petSchema.index({searchKey: "text"});

export const Pet = getOrCreateModel<PetDoc>("Pet", petSchema);

export function buildPetSearchKey(fields: Pick<PetDoc, "name" | "species" | "breed">): string {
  return [fields.name, fields.species, fields.breed]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
