import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";
import {randomUUID} from "node:crypto";
import type {ReceiptRecord} from "@/lib/registration/receipt";

/**
 * One registered wallet - plans/wp4.2-client-wallet-registration.md, dogtag-vet section 1: "address
 * unique per client (same wallet MAY appear on different clients)". `receipt`/`receiptHash` are
 * the self-authenticating, offline-re-verifiable proof (docs/client-wallet-registration.md);
 * `revokedAt` is a bookkeeping flag only - a revoked entry is never deleted, so the receipt stays
 * available forever regardless of revocation.
 */
export interface ClientWallet {
  address: string; // lowercase 0x hex, unique within this client's wallets[]
  label?: string;
  registrationId: string; // the session's UUID v4
  receipt: ReceiptRecord;
  receiptHash: string;
  issuedAt: number; // unix seconds, denormalized from receipt.payloadJson's message for display
  blockNumber: number; // denormalized from receipt.payloadJson's message for display
  registeredAt: number; // unix seconds this wallet was appended (server "now" at /w/:token/complete)
  revokedAt?: number; // unix seconds; undefined = active
}

export interface ClientDoc {
  clientId: string;
  name: string;
  email?: string;
  phone?: string;
  address?: string;
  notes?: string;
  petIds: string[];
  wallets: ClientWallet[];
  searchKey: string;
  createdAt: Date;
  updatedAt: Date;
}

const clientWalletReceiptSchema = new Schema<ReceiptRecord>(
  {
    payloadJson: {type: String, required: true},
    signature: {type: String, required: true},
    recoveredAt: {type: Number, required: true},
  },
  {_id: false},
);

const clientWalletSchema = new Schema<ClientWallet>(
  {
    address: {type: String, required: true},
    label: String,
    registrationId: {type: String, required: true},
    receipt: {type: clientWalletReceiptSchema, required: true},
    receiptHash: {type: String, required: true},
    issuedAt: {type: Number, required: true},
    blockNumber: {type: Number, required: true},
    registeredAt: {type: Number, required: true},
    revokedAt: Number,
  },
  {_id: false},
);

const clientSchema = new Schema<ClientDoc>(
  {
    clientId: {type: String, required: true, unique: true, default: () => randomUUID()},
    name: {type: String, required: true, trim: true},
    email: {type: String, trim: true, lowercase: true},
    phone: {type: String, trim: true},
    address: {type: String, trim: true},
    notes: {type: String},
    petIds: {type: [String], default: []},
    wallets: {type: [clientWalletSchema], default: []},
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
