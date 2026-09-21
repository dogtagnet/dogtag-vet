import type {PaymentChainKey} from "@/lib/chains";

/**
 * Pure status computation for the worker's `GET /healthz` and `GET /livez` (WP4.17 B10 -
 * `src/worker/health.ts` is the only caller, and the only place that touches Mongo/RPC to build
 * the snapshot this file consumes). Kept free of any I/O so the three required cases - fresh,
 * stalled, Mongo down - are plain data-in/data-out unit tests (`tests/unit/workerHealth.test.ts`),
 * and so a bite mutation on `isStalled` shows up as a red test by name instead of needing a live
 * worker process to reproduce.
 *
 * Two SEPARATE reports, not one, because they answer different questions for Kubernetes:
 *
 * - Readiness (`computeReadiness`) answers "can this worker currently do useful work" - Mongo
 *   unreachable belongs here, since a worker that cannot read/write its own cursors is not usefully
 *   ready even if its loops are still ticking on schedule.
 * - Liveness (`computeLiveness`) answers "is this process wedged and worth killing" - Mongo (and
 *   the ROAX/payment RPCs) are EXTERNAL dependencies a restart cannot fix, so they must never be
 *   part of this answer. This matters concretely here: `src/worker/index.ts`'s `main()` calls
 *   `connectToDatabase()` BEFORE the health server ever starts listening, so if liveness also
 *   failed on "Mongo unreachable", a Mongo outage at boot would crash-loop the container (connect
 *   throws, process exits, kubelet restarts, connect throws again) instead of leaving one process
 *   up to retry on its own schedule. `LivenessSnapshot` has no `mongoConnected` field at all - by
 *   construction, not just convention, nothing Mongo-shaped can leak into this decision.
 *
 * The admin worker's own `/healthz` (`dogtag-admin/worker/index.ts`, read as this feature's
 * pattern) does not make this split - it always answers 200 regardless of `state.lastError`, which
 * makes its own probes unable to ever fail. Kubernetes probes only look at the HTTP status code,
 * so `src/worker/health.ts` answers 503 whenever a report is "degraded" - the split above is what
 * keeps that 503 from being able to crash-loop the container over a dependency outage.
 */

export type WorkerHealthStatus = "ok" | "degraded";

/**
 * `lastAt === null` (never observed even once) is treated as stalled, not given a free pass - in
 * practice this should never be seen after boot, since `src/worker/health.ts` seeds both
 * timestamps to the process start time (mirroring dogtag-admin worker/index.ts's identical
 * `lastBlockSeenAt: new Date()` seeding) specifically so an outage present from the very first
 * tick still ages into a stall instead of reading as fresh forever.
 */
export function isStalled(lastAt: Date | null, now: Date, stallMinutes: number): boolean {
  if (lastAt === null) return true;
  const minutesSince = (now.getTime() - lastAt.getTime()) / 60_000;
  return minutesSince >= stallMinutes;
}

export interface LivenessSnapshot {
  now: Date;
  stallMinutes: number;
  /**
   * The chain-activity follower's own liveness signal is PROGRESS on the observed ROAX chain tip,
   * not "did an attempt happen" - `src/worker/index.ts`'s `followOnce` calls `getBlockNumber()`
   * before it even checks whether this clinic has finished onboarding, and the loop wrapper only
   * advances this timestamp when that observed tip exceeds the highest one seen so far. This is
   * deliberately the same shape as dogtag-admin's `lastBlockSeenAt`, and for the same reason
   * stated in that file's own comment: a stalled follower is exactly as likely to show up as a run
   * of thrown iterations (RPC unreachable) as a run of iterations that complete but never observe
   * a new block, so an attempt-only timestamp (which advances on both a success AND a caught
   * throw) would almost never go stale - it would only catch a fully wedged event loop, which also
   * stops answering this very endpoint, making the check nearly dead code. Tracking observed tip
   * progress instead catches the actually-likely failure: a dead or stuck RPC.
   *
   * This also means a clinic that has not finished the setup wizard yet (`cloneAddress` unset)
   * reads as fresh, not stalled, for as long as ROAX itself keeps producing blocks - `followOnce`
   * observes the tip on every iteration regardless of onboarding state, so "not onboarded yet" and
   * "RPC is dead" are never confused with each other.
   */
  activityFollowerLastTipAt: Date | null;
  /**
   * The payment watcher's liveness signal, by contrast, IS attempt-based (last tick, success or
   * caught failure) - `runPaymentWatcherOnce` returns immediately whenever there is no pending
   * payment on any chain at all, which is the common case, so a progress signal (a per-chain
   * cursor advancing) would read "stalled" on a perfectly healthy, simply idle clinic. Tick
   * liveness has no such false positive: it only asks "did the loop wrapper complete an attempt
   * recently", which is true whether or not there was ever any work to do.
   */
  paymentWatcherLastPollAt: Date | null;
}

export interface HealthReport {
  status: WorkerHealthStatus;
  reasons: string[];
}

/** Shared by both reports below - liveness's reasons are always a subset of readiness's. */
function computeLivenessReasons(snapshot: LivenessSnapshot): string[] {
  const reasons: string[] = [];
  if (isStalled(snapshot.activityFollowerLastTipAt, snapshot.now, snapshot.stallMinutes)) {
    reasons.push("activity follower stalled");
  }
  if (isStalled(snapshot.paymentWatcherLastPollAt, snapshot.now, snapshot.stallMinutes)) {
    reasons.push("payment watcher stalled");
  }
  return reasons;
}

export function computeLiveness(snapshot: LivenessSnapshot): HealthReport {
  const reasons = computeLivenessReasons(snapshot);
  return {status: reasons.length === 0 ? "ok" : "degraded", reasons};
}

export interface PaymentChainCursorInfo {
  chainKey: PaymentChainKey;
  cursorBlock: number | null;
}

export interface ReadinessSnapshot extends LivenessSnapshot {
  mongoConnected: boolean;
  activityFollowerCursorBlock: number | null;
  paymentWatcherChains: PaymentChainCursorInfo[];
}

export interface ReadinessReport {
  status: WorkerHealthStatus;
  reasons: string[];
  stallMinutes: number;
  mongo: {connected: boolean};
  activityFollower: {cursorBlock: number | null; lastPollAt: string | null};
  paymentWatcher: {
    chains: Array<{chainKey: PaymentChainKey; cursorBlock: number | null; lastPollAt: string | null}>;
  };
}

/**
 * The full report served on `/healthz` - everything `computeLiveness` checks, plus Mongo
 * connectivity, plus the diagnostic fields WP4.17 B10 asks this endpoint to report: the activity
 * cursor (block and last poll time) and the payment watcher's per-chain state (last poll, cursor).
 * Every chain currently carries the SAME `lastPollAt` (see `LivenessSnapshot.paymentWatcherLastPollAt`'s
 * doc comment - one shared loop, one cadence, examines every chain each tick) - reported per chain
 * anyway, rather than once at the `paymentWatcher` level, so the shape does not need to change if a
 * later revision ever makes the four chains' polling genuinely independent.
 */
export function computeReadiness(snapshot: ReadinessSnapshot): ReadinessReport {
  const reasons = computeLivenessReasons(snapshot);
  if (!snapshot.mongoConnected) reasons.unshift("mongo unreachable");
  const paymentWatcherLastPollAtIso = snapshot.paymentWatcherLastPollAt?.toISOString() ?? null;
  return {
    status: reasons.length === 0 ? "ok" : "degraded",
    reasons,
    stallMinutes: snapshot.stallMinutes,
    mongo: {connected: snapshot.mongoConnected},
    activityFollower: {
      cursorBlock: snapshot.activityFollowerCursorBlock,
      lastPollAt: snapshot.activityFollowerLastTipAt?.toISOString() ?? null,
    },
    paymentWatcher: {
      chains: snapshot.paymentWatcherChains.map((chain) => ({
        chainKey: chain.chainKey,
        cursorBlock: chain.cursorBlock,
        lastPollAt: paymentWatcherLastPollAtIso,
      })),
    },
  };
}
