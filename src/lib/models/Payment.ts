import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";
import {randomUUID, randomBytes} from "node:crypto";
import type {PaymentChainKey} from "@/lib/chains";

export type PaymentStatus = "pending" | "paid" | "cancelled" | "expired";
export type PaymentToken = "ETH" | "USDC" | "USDT";

export interface LineItem {
  description: string;
  qty: number;
  unitAmount: string; // decimal string
  amount: string; // decimal string
}

export interface TaxLine {
  label: string;
  rate: string; // decimal string, e.g. "0.0825"
  amount: string;
}

export interface CryptoRail {
  chainKey: PaymentChainKey;
  token: PaymentToken;
  tokenAddress?: string; // absent for native ETH
  decimals: number;
  quotedRate: string; // fiat per token, decimal string
  amountBase: string; // integer string in token base units, includes unique dust suffix
  receivingAddress: string;
  eip681: string;
}

export interface PaidWith {
  chainKey: PaymentChainKey;
  token: PaymentToken;
  txHash: string;
  from: string;
  amountBase: string;
  blockNumber: number;
  confirmedAt: Date;
}

export interface EmailedRecord {
  email: string;
  at: Date;
}

export interface PaymentDoc {
  paymentId: string;
  invoiceNumber: string;
  clientId?: string;
  petId?: string;
  appointmentId?: string;
  lineItems: LineItem[];
  currency: string;
  subtotal: string;
  tax?: TaxLine;
  total: string;
  status: PaymentStatus;
  dueAt?: number;
  crypto: CryptoRail[];
  paidWith?: PaidWith;
  receiptToken: string;
  emailedTo: EmailedRecord[];
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const lineItemSchema = new Schema<LineItem>(
  {
    description: {type: String, required: true},
    qty: {type: Number, required: true, min: 0},
    unitAmount: {type: String, required: true},
    amount: {type: String, required: true},
  },
  {_id: false},
);

const taxLineSchema = new Schema<TaxLine>(
  {
    label: {type: String, required: true},
    rate: {type: String, required: true},
    amount: {type: String, required: true},
  },
  {_id: false},
);

const cryptoRailSchema = new Schema<CryptoRail>(
  {
    chainKey: {type: String, enum: ["ethereum", "base", "sepolia", "baseSepolia"], required: true},
    token: {type: String, enum: ["ETH", "USDC", "USDT"], required: true},
    tokenAddress: String,
    decimals: {type: Number, required: true},
    quotedRate: {type: String, required: true},
    amountBase: {type: String, required: true},
    receivingAddress: {type: String, required: true},
    eip681: {type: String, required: true},
  },
  {_id: false},
);

const paidWithSchema = new Schema<PaidWith>(
  {
    chainKey: {type: String, enum: ["ethereum", "base", "sepolia", "baseSepolia"], required: true},
    token: {type: String, enum: ["ETH", "USDC", "USDT"], required: true},
    txHash: {type: String, required: true},
    from: {type: String, required: true},
    amountBase: {type: String, required: true},
    blockNumber: {type: Number, required: true},
    confirmedAt: {type: Date, required: true},
  },
  {_id: false},
);

const emailedRecordSchema = new Schema<EmailedRecord>(
  {
    email: {type: String, required: true},
    at: {type: Date, required: true},
  },
  {_id: false},
);

const paymentSchema = new Schema<PaymentDoc>(
  {
    paymentId: {type: String, required: true, unique: true, default: () => randomUUID()},
    invoiceNumber: {type: String, required: true, unique: true},
    clientId: {type: String, index: true},
    petId: {type: String, index: true},
    appointmentId: {type: String, index: true},
    lineItems: {type: [lineItemSchema], required: true, default: []},
    currency: {type: String, required: true},
    subtotal: {type: String, required: true},
    tax: taxLineSchema,
    total: {type: String, required: true},
    status: {
      type: String,
      enum: ["pending", "paid", "cancelled", "expired"],
      required: true,
      default: "pending",
      index: true,
    },
    dueAt: Number,
    crypto: {type: [cryptoRailSchema], default: []},
    paidWith: paidWithSchema,
    receiptToken: {
      type: String,
      required: true,
      unique: true,
      default: () => randomBytes(18).toString("base64url"),
    },
    emailedTo: {type: [emailedRecordSchema], default: []},
    notes: String,
  },
  {timestamps: true},
);

// Dust-suffix uniqueness is enforced among OPEN payments per (chain, token, receivingAddress);
// this compound index is the write-time guard the payment-creation flow checks against, and later
// the watcher's exact-amount match relies on it to be a true 1:1 key while a payment is pending.
paymentSchema.index({"crypto.chainKey": 1, "crypto.token": 1, "crypto.receivingAddress": 1, "crypto.amountBase": 1});

export const Payment = getOrCreateModel<PaymentDoc>("Payment", paymentSchema);
