import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";
import {randomUUID} from "node:crypto";

export interface Money {
  amount: string; // canonical decimal string, e.g. "45.00"
  currency: string; // ISO 4217
}

export interface ServiceDoc {
  serviceId: string;
  name: string;
  description?: string;
  durationMinutes: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  price?: Money;
  active: boolean;
  bookableOnline: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const moneySchema = new Schema<Money>(
  {
    amount: {type: String, required: true},
    currency: {type: String, required: true},
  },
  {_id: false},
);

const serviceSchema = new Schema<ServiceDoc>(
  {
    serviceId: {type: String, required: true, unique: true, default: () => randomUUID()},
    name: {type: String, required: true, trim: true},
    description: String,
    durationMinutes: {type: Number, required: true, min: 1},
    bufferBeforeMin: {type: Number, required: true, default: 0, min: 0},
    bufferAfterMin: {type: Number, required: true, default: 0, min: 0},
    price: moneySchema,
    active: {type: Boolean, required: true, default: true},
    bookableOnline: {type: Boolean, required: true, default: false},
  },
  {timestamps: true},
);

export const Service = getOrCreateModel<ServiceDoc>("Service", serviceSchema);
