import {createServer, type Server, type ServerResponse} from "node:http";
import mongoose from "mongoose";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {PaymentChainCursor} from "@/lib/models/PaymentChainCursor";
import {ALL_CHAIN_KEYS} from "@/lib/payments/tokenRegistry";
import {computeLiveness, computeReadiness, type PaymentChainCursorInfo} from "@/lib/health/workerHealth";

/**
 * WP4.17 B10 - the worker's `GET /healthz` and `GET /livez`. This file is the I/O half (Mongo
 * reads, the in-memory poll-state the two `src/worker/index.ts` loops update, the actual
 * `node:http` server); `src/lib/health/workerHealth.ts` is the pure half (the ok/degraded
 * computation itself) - see that file's doc comment for why the split exists and why liveness and
 * readiness are two different questions here.
 */

export interface WorkerPollState {
  /** Progress signal - feeds readiness only. See `ReadinessSnapshot.activityFollowerLastTipAt`. */
  activityFollowerLastTipAt: Date | null;
  activityFollowerLastTipSeen: bigint | null;
  /** Attempt signal - feeds liveness only. See `LivenessSnapshot.activityFollowerLastAttemptAt`. */
  activityFollowerLastAttemptAt: Date | null;
  paymentWatcherLastPollAt: Date | null;
}

/**
 * Seeded to the process start time, not `null` - see `workerHealth.ts`'s `isStalled` doc comment:
 * a `null` reads as stalled, so seeding at boot (mirroring dogtag-admin worker/index.ts's
 * identical `lastBlockSeenAt: new Date()`) means an outage present from the very first tick still
 * ages into a stall after `stallMinutes`, instead of reading as fresh forever because the loop
 * never got a chance to run once.
 */
export function createInitialPollState(now: Date = new Date()): WorkerPollState {
  return {
    activityFollowerLastTipAt: now,
    activityFollowerLastTipSeen: null,
    activityFollowerLastAttemptAt: now,
    paymentWatcherLastPollAt: now,
  };
}

/**
 * Called once per chain-activity-follower loop iteration that actually observed a tip (inside
 * `src/worker/index.ts`'s try block, never on a caught throw) with the ROAX block number that
 * iteration observed (`followOnce` now returns this on every path, including its early "not
 * onboarded yet" and "nothing new" returns - it calls `getBlockNumber()` before checking either).
 * Only advances `lastTipAt` when `observedTip` exceeds the highest tip seen so far, so a follower
 * that is genuinely stuck (repeatedly observing the SAME tip because its RPC is stale/cached, or
 * never reaching here at all because an iteration threw first) ages into a readiness stall - see
 * `ReadinessSnapshot.activityFollowerLastTipAt` in workerHealth.ts. Deliberately feeds readiness
 * only, never liveness - see `recordActivityFollowerAttempt` below and workerHealth.ts's module
 * doc comment for why.
 */
export function recordActivityFollowerTip(state: WorkerPollState, observedTip: bigint, now: Date = new Date()): void {
  if (state.activityFollowerLastTipSeen !== null && observedTip <= state.activityFollowerLastTipSeen) return;
  state.activityFollowerLastTipSeen = observedTip;
  state.activityFollowerLastTipAt = now;
}

/**
 * Called once per chain-activity-follower loop iteration, unconditionally, AFTER its try/catch -
 * whether that iteration observed a tip or threw. This is what liveness reads
 * (`LivenessSnapshot.activityFollowerLastAttemptAt`), deliberately never the progress signal above:
 * a dead ROAX RPC makes `followOnce` throw at its very first call, every iteration, forever, and if
 * liveness reacted to that the way readiness correctly does, a bad `ROAX_RPC_URL` would crash-loop
 * the container instead of just marking the pod not-ready - see workerHealth.ts's module doc
 * comment for the full reasoning (the same trap Mongo is kept out of liveness for).
 */
export function recordActivityFollowerAttempt(state: WorkerPollState, now: Date = new Date()): void {
  state.activityFollowerLastAttemptAt = now;
}

/** Called once per payment-watcher loop iteration, whether that iteration succeeded, found
 * nothing to do, or threw and was caught - see `LivenessSnapshot.paymentWatcherLastPollAt` in
 * workerHealth.ts for why this signal is attempt-based rather than progress-based. */
export function recordPaymentWatcherPoll(state: WorkerPollState, now: Date = new Date()): void {
  state.paymentWatcherLastPollAt = now;
}

async function checkMongoConnectivity(): Promise<boolean> {
  try {
    if (mongoose.connection.readyState !== 1) return false;
    const db = mongoose.connection.db;
    if (!db) return false;
    await db.admin().command({ping: 1});
    return true;
  } catch {
    return false;
  }
}

async function getActivityFollowerCursorBlock(): Promise<number | null> {
  try {
    const settings = await getClinicSettings();
    return settings.activityCursorBlock ?? null;
  } catch {
    return null;
  }
}

async function getPaymentWatcherChainCursors(): Promise<PaymentChainCursorInfo[]> {
  try {
    const docs = await PaymentChainCursor.find({_id: {$in: ALL_CHAIN_KEYS}}).lean<
      Array<{_id: string; blockNumber: number}>
    >();
    const byKey = new Map(docs.map((doc) => [doc._id, doc.blockNumber]));
    return ALL_CHAIN_KEYS.map((chainKey) => ({chainKey, cursorBlock: byKey.get(chainKey) ?? null}));
  } catch {
    return ALL_CHAIN_KEYS.map((chainKey) => ({chainKey, cursorBlock: null}));
  }
}

/**
 * Real, Mongo-backed dependencies for `createHealthServer`. `tests/unit/workerHealthServer.test.ts`
 * overrides this with stubs that never touch a real database, so the "the endpoint responds" test
 * needs no live Mongo at all and cannot accidentally reach one either.
 */
export interface HealthServerDeps {
  checkMongoConnectivity: () => Promise<boolean>;
  getActivityFollowerCursorBlock: () => Promise<number | null>;
  getPaymentWatcherChainCursors: () => Promise<PaymentChainCursorInfo[]>;
}

export const defaultHealthServerDeps: HealthServerDeps = {
  checkMongoConnectivity,
  getActivityFollowerCursorBlock,
  getPaymentWatcherChainCursors,
};

function respondJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {"content-type": "application/json"});
  res.end(JSON.stringify(body));
}

/**
 * Builds (but does not start) the worker's health HTTP server. Two routes:
 *
 * - `GET /healthz` (readiness): Mongo connectivity plus both loops' staleness, with the full
 *   diagnostic payload B10 asks for - the activity cursor (block and last poll time) and the
 *   payment watcher's per-chain state (last poll, cursor).
 * - `GET /livez` (liveness): both loops' staleness ONLY, never Mongo - see workerHealth.ts's
 *   `LivenessSnapshot` doc comment for why Mongo must never gate this route (a boot-time Mongo
 *   outage would otherwise crash-loop the container instead of leaving one process up to retry).
 *
 * Either route answers 503 (never a hang or a dropped connection) when its report comes back
 * "degraded", so a real Kubernetes probe against it can actually fail - unlike the admin worker's
 * own `/healthz` (this feature's pattern), which always answers 200 regardless of `state.lastError`.
 * Exported separately from `startHealthServer` below so tests can `.listen(0)` it themselves and
 * read back the OS-assigned port, rather than binding the real `WORKER_HEALTH_PORT`.
 */
export function createHealthServer(
  state: WorkerPollState,
  stallMinutes: number,
  deps: HealthServerDeps = defaultHealthServerDeps,
): Server {
  return createServer((req, res) => {
    if (req.url === "/livez") {
      const report = computeLiveness({
        now: new Date(),
        stallMinutes,
        activityFollowerLastAttemptAt: state.activityFollowerLastAttemptAt,
        paymentWatcherLastPollAt: state.paymentWatcherLastPollAt,
      });
      respondJson(res, report.status === "ok" ? 200 : 503, report);
      return;
    }
    if (req.url === "/healthz") {
      void (async () => {
        const [mongoConnected, activityFollowerCursorBlock, paymentWatcherChains] = await Promise.all([
          deps.checkMongoConnectivity(),
          deps.getActivityFollowerCursorBlock(),
          deps.getPaymentWatcherChainCursors(),
        ]);
        const report = computeReadiness({
          now: new Date(),
          stallMinutes,
          mongoConnected,
          activityFollowerLastTipAt: state.activityFollowerLastTipAt,
          activityFollowerCursorBlock,
          paymentWatcherLastPollAt: state.paymentWatcherLastPollAt,
          paymentWatcherChains,
        });
        respondJson(res, report.status === "ok" ? 200 : 503, report);
      })();
      return;
    }
    respondJson(res, 404, {error: "not found"});
  });
}

/** Creates and starts the health server on `port` (`WORKER_HEALTH_PORT`, default 8091) - what
 * `src/worker/index.ts`'s `main()` actually calls. */
export function startHealthServer(
  port: number,
  state: WorkerPollState,
  stallMinutes: number,
  deps: HealthServerDeps = defaultHealthServerDeps,
): Server {
  const server = createHealthServer(state, stallMinutes, deps);
  server.listen(port);
  return server;
}
