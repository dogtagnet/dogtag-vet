import {describe, expect, it} from "vitest";
import {
  computeLiveness,
  computeReadiness,
  isStalled,
  type LivenessSnapshot,
  type ReadinessSnapshot,
} from "@/lib/health/workerHealth";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const STALL_MINUTES = 10;

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

function freshLiveness(): LivenessSnapshot {
  return {
    now: NOW,
    stallMinutes: STALL_MINUTES,
    activityFollowerLastAttemptAt: minutesAgo(1),
    paymentWatcherLastPollAt: minutesAgo(1),
  };
}

function freshReadiness(): ReadinessSnapshot {
  return {
    now: NOW,
    stallMinutes: STALL_MINUTES,
    mongoConnected: true,
    activityFollowerLastTipAt: minutesAgo(1),
    activityFollowerCursorBlock: 12345,
    paymentWatcherLastPollAt: minutesAgo(1),
    // WP4.18 - ROAX is the only payment chain, so this array carries exactly one entry today
    // (previously four, one per removed chain); `cursorBlock: null` still models "never scanned
    // yet" on a fresh deployment.
    paymentWatcherChains: [{chainKey: "roax", cursorBlock: 100}],
  };
}

describe("isStalled", () => {
  it("is not stalled just under the threshold", () => {
    expect(isStalled(minutesAgo(9), NOW, STALL_MINUTES)).toBe(false);
  });

  it("is stalled exactly at the threshold (boundary is inclusive)", () => {
    expect(isStalled(minutesAgo(10), NOW, STALL_MINUTES)).toBe(true);
  });

  it("is stalled well past the threshold", () => {
    expect(isStalled(minutesAgo(45), NOW, STALL_MINUTES)).toBe(true);
  });

  it("treats a timestamp that was never set (null) as stalled, not fresh", () => {
    expect(isStalled(null, NOW, STALL_MINUTES)).toBe(true);
  });
});

describe("computeReadiness (GET /healthz)", () => {
  it("fresh: reports ok when both loops are recent and mongo is connected", () => {
    const report = computeReadiness(freshReadiness());
    expect(report.status).toBe("ok");
    expect(report.reasons).toEqual([]);
    expect(report.mongo).toEqual({connected: true});
    expect(report.activityFollower).toEqual({cursorBlock: 12345, lastPollAt: minutesAgo(1).toISOString()});
  });

  it("stalled: reports degraded when the activity follower's observed chain tip has not advanced within the stall window", () => {
    const report = computeReadiness({...freshReadiness(), activityFollowerLastTipAt: minutesAgo(30)});
    expect(report.status).toBe("degraded");
    expect(report.reasons).toContain("activity follower stalled");
  });

  it("stalled: reports degraded when the payment watcher has not polled within the stall window", () => {
    const report = computeReadiness({...freshReadiness(), paymentWatcherLastPollAt: minutesAgo(30)});
    expect(report.status).toBe("degraded");
    expect(report.reasons).toContain("payment watcher stalled");
  });

  it("mongo down: reports degraded when mongo is unreachable even though both loops are fresh", () => {
    const report = computeReadiness({...freshReadiness(), mongoConnected: false});
    expect(report.status).toBe("degraded");
    expect(report.reasons).toEqual(["mongo unreachable"]);
    expect(report.mongo).toEqual({connected: false});
  });

  it("reports every payment chain with the shared poll timestamp and its own cursor", () => {
    const report = computeReadiness(freshReadiness());
    expect(report.paymentWatcher.chains).toEqual([{chainKey: "roax", cursorBlock: 100, lastPollAt: minutesAgo(1).toISOString()}]);
  });

  it("combines multiple simultaneous problems into one degraded report", () => {
    const report = computeReadiness({
      ...freshReadiness(),
      mongoConnected: false,
      activityFollowerLastTipAt: minutesAgo(30),
    });
    expect(report.status).toBe("degraded");
    expect(report.reasons).toEqual(["mongo unreachable", "activity follower stalled"]);
  });

  /**
   * The regression this whole readiness/liveness split exists to prevent (see workerHealth.ts's
   * module doc comment): a dead ROAX RPC makes `followOnce` throw at its very first call, so the
   * PROGRESS signal (`activityFollowerLastTipAt`) goes stale while the ATTEMPT signal
   * (`activityFollowerLastAttemptAt`, computeLiveness below) stays fresh - the loop is very much
   * alive and retrying on schedule, it just cannot reach ROAX. Readiness must still degrade here
   * (a real operational fact worth surfacing), but liveness must NOT - see the paired test in the
   * computeLiveness block below. An earlier draft of this feature read the follower's liveness
   * from the progress signal too, which would have crash-looped the container on exactly this
   * scenario, the same trap Mongo is deliberately kept out of liveness for.
   */
  it("degrades on a stale observed chain tip even while the follower is still attempting on schedule", () => {
    const report = computeReadiness({...freshReadiness(), activityFollowerLastTipAt: minutesAgo(30)});
    expect(report.status).toBe("degraded");
    expect(report.reasons).toEqual(["activity follower stalled"]);
  });
});

describe("computeLiveness (GET /livez)", () => {
  it("fresh: reports ok when both loops are recent", () => {
    expect(computeLiveness(freshLiveness())).toEqual({status: "ok", reasons: []});
  });

  it("stalled: reports degraded when a loop is genuinely stalled", () => {
    const report = computeLiveness({...freshLiveness(), activityFollowerLastAttemptAt: minutesAgo(30)});
    expect(report.status).toBe("degraded");
    expect(report.reasons).toEqual(["activity follower stalled"]);
  });

  /**
   * The decoupling this whole readiness/liveness split exists for (see workerHealth.ts's module
   * doc comment): liveness has no `mongoConnected` field to check at all, so a Mongo outage can
   * never fail this route - only `/healthz` (computeReadiness) reacts to it. This matters because
   * `src/worker/index.ts`'s `main()` calls `connectToDatabase()` before the health server ever
   * starts listening - if liveness could fail on a Mongo outage, a boot-time outage would
   * crash-loop the container instead of leaving one process up to retry.
   */
  it("stays ok when only mongo is down - liveness never checks mongo connectivity", () => {
    const readiness = computeReadiness({...freshReadiness(), mongoConnected: false});
    expect(readiness.status).toBe("degraded"); // readiness DOES react to it
    const liveness = computeLiveness(freshLiveness());
    expect(liveness).toEqual({status: "ok", reasons: []});
  });

  /**
   * The companion to the "degrades on a stale observed chain tip" readiness test above, and the
   * actual regression fix: a dead ROAX RPC (fresh attempts, stale tip) must leave LIVENESS ok even
   * though it correctly leaves READINESS degraded - liveness restarting the container over an RPC
   * it does not control would only crash-loop it, never fix the RPC.
   */
  it("stays ok on a dead ROAX RPC (fresh attempts, stale tip) even though readiness correctly degrades", () => {
    const readiness = computeReadiness({...freshReadiness(), activityFollowerLastTipAt: minutesAgo(30)});
    expect(readiness.status).toBe("degraded");
    const liveness = computeLiveness(freshLiveness()); // attempts are still fresh - the loop retries on schedule
    expect(liveness).toEqual({status: "ok", reasons: []});
  });
});
