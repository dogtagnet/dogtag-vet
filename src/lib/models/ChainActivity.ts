import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";

/** This clinic's clone events (TagIssued, TagRevoked, ...) plus their SBT StatusChanged/Verified
 * events - never another clinic's activity. `id` is `"{txHash}:{logIndex}"`, globally unique, so
 * the chunked-getLogs follower (worker, later stage) can upsert idempotently on replay. */
export interface ChainActivityDoc {
  id: string;
  type: string;
  blockNumber: number;
  txHash: string;
  logIndex: number;
  blockTimestamp: number;
  dogTagId?: string;
  root?: string;
  reasonCode?: string;
  operator?: string;
  raw: unknown;
}

const chainActivitySchema = new Schema<ChainActivityDoc>({
  id: {type: String, required: true, unique: true},
  type: {type: String, required: true, index: true},
  blockNumber: {type: Number, required: true, index: true},
  txHash: {type: String, required: true},
  logIndex: {type: Number, required: true},
  blockTimestamp: {type: Number, required: true, index: true},
  dogTagId: {type: String, index: true},
  root: String,
  reasonCode: String,
  operator: String,
  raw: Schema.Types.Mixed,
});

export const ChainActivity =
  getOrCreateModel<ChainActivityDoc>("ChainActivity", chainActivitySchema);
