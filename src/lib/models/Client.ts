import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";
import {randomUUID} from "node:crypto";

export interface ClientDoc {
  clientId: string;
  name: string;
  email?: string;
  phone?: string;
  address?: string;
  notes?: string;
  petIds: string[];
  searchKey: string;
  createdAt: Date;
  updatedAt: Date;
}

const clientSchema = new Schema<ClientDoc>(
  {
    clientId: {type: String, required: true, unique: true, default: () => randomUUID()},
    name: {type: String, required: true, trim: true},
    email: {type: String, trim: true, lowercase: true},
    phone: {type: String, trim: true},
    address: {type: String, trim: true},
    notes: {type: String},
    petIds: {type: [String], default: []},
    searchKey: {type: String, required: true, index: true},
  },
  {timestamps: true},
);

clientSchema.index({searchKey: "text"});

export const Client = getOrCreateModel<ClientDoc>("Client", clientSchema);

/** Lowercased, whitespace-collapsed name+email+phone blob used for the search box - kept
 * denormalized on the document so listing/search queries never need a runtime join or regex
 * across multiple fields. */
export function buildClientSearchKey(fields: Pick<ClientDoc, "name" | "email" | "phone">): string {
  return [fields.name, fields.email, fields.phone]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
