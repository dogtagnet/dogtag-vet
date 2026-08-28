import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";

/**
 * "Public API protection" (wp4-vet.md) asks for rate limits, body size caps, and an abuse log.
 * This is that log: one document per (route, clientKey, reason, hour), incremented rather than
 * appended-to on every violation. Append-one-row-per-hit would let the exact traffic this log
 * exists to record (a flood of blocked requests) also flood Mongo with writes - the amplification
 * `enforceRateLimit`'s 429 is supposed to prevent. Bucketing by hour keeps write volume bounded to
 * one upsert per offender per route per hour, however many requests they actually send.
 *
 * `expiresAt` carries a TTL index so entries self-prune - `RETENTION_DAYS` below is this
 * deployment's whole retention policy for what is otherwise indefinitely-stored IP address data;
 * see docs/DEPLOY.md.
 */
export type AbuseReason = "rate_limited" | "body_too_large";

export interface AbuseLogDoc {
  _id: string; // `${route}:${clientKey}:${reason}:${hourBucket}`
  route: string;
  clientKey: string;
  reason: AbuseReason;
  count: number;
  windowStart: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

export const ABUSE_LOG_RETENTION_DAYS = 14;

const abuseLogSchema = new Schema<AbuseLogDoc>({
  _id: {type: String, required: true},
  route: {type: String, required: true, index: true},
  clientKey: {type: String, required: true},
  reason: {type: String, enum: ["rate_limited", "body_too_large"], required: true},
  count: {type: Number, required: true, default: 0},
  windowStart: {type: Date, required: true},
  lastSeenAt: {type: Date, required: true},
  expiresAt: {type: Date, required: true, expires: 0},
});

export const AbuseLog = getOrCreateModel<AbuseLogDoc>("AbuseLog", abuseLogSchema);
