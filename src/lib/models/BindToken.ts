import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";
import {randomBytes} from "node:crypto";

export interface BindTokenDoc {
  token: string; // 32 lowercase hex, unique - see specs/qr-formats.md
  sessionId: string;
  exp: number; // unix seconds
  consumed: boolean;
}

const bindTokenSchema = new Schema<BindTokenDoc>({
  token: {type: String, required: true, unique: true},
  sessionId: {type: String, required: true, index: true},
  exp: {type: Number, required: true},
  consumed: {type: Boolean, required: true, default: false},
});

export const BindToken =
  getOrCreateModel<BindTokenDoc>("BindToken", bindTokenSchema);

/** 32 lowercase hex characters - the v1-compatible mint/verify token grammar
 * (`^[0-9a-f]{32}$`, specs/qr-formats.md). */
export function generateHexToken(): string {
  return randomBytes(16).toString("hex");
}
