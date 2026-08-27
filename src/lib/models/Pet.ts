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

export interface DogTagInfo {
  dogTagIdDec?: string;
  dogTagIdField?: string;
  root?: string;
  status?: DogTagStatus;
  issuedTx?: string;
  cloneAddress?: string;
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

const microchipSchema = new Schema<MicrochipInfo>(
  {
    code: String,
    standard: {type: String, enum: ["ISO11784", "ISO11785", "FDX-B", "other"]},
    implantDate: String,
    bodyLocation: String,
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
