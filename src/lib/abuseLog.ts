import "server-only";
import {connectToDatabase} from "@/lib/db";
import {AbuseLog, ABUSE_LOG_RETENTION_DAYS, type AbuseReason} from "@/lib/models/AbuseLog";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Best-effort abuse-log write: called from the hot rejection paths (`enforceRateLimit`'s 429,
 * `readJsonBody`'s too-large case) where a logging failure must never turn into a failed request
 * or an unhandled rejection. Callers fire this without awaiting it (`void recordAbuse(...)`).
 */
export async function recordAbuse(route: string, clientKey: string, reason: AbuseReason, now = Date.now()): Promise<void> {
  try {
    await connectToDatabase();
    const hourBucket = Math.floor(now / HOUR_MS);
    const id = `${route}:${clientKey}:${reason}:${hourBucket}`;
    const windowStart = new Date(hourBucket * HOUR_MS);
    const lastSeenAt = new Date(now);
    const expiresAt = new Date(now + ABUSE_LOG_RETENTION_DAYS * 24 * HOUR_MS);
    await AbuseLog.findByIdAndUpdate(
      id,
      {
        $inc: {count: 1},
        $set: {lastSeenAt, expiresAt},
        $setOnInsert: {route, clientKey, reason, windowStart},
      },
      {upsert: true},
    );
  } catch {
    // Never let abuse logging itself become a source of request failure or unbounded retries.
  }
}

export interface AbuseLogEntry {
  route: string;
  clientKey: string;
  reason: AbuseReason;
  count: number;
  lastSeenAt: Date;
}

/** Most recently active abuse entries, newest first, for the Settings page's read-only view. */
export async function listRecentAbuse(limit = 20): Promise<AbuseLogEntry[]> {
  await connectToDatabase();
  const docs = await AbuseLog.find().sort({lastSeenAt: -1}).limit(limit).lean();
  return docs.map((d) => ({route: d.route, clientKey: d.clientKey, reason: d.reason, count: d.count, lastSeenAt: d.lastSeenAt}));
}
