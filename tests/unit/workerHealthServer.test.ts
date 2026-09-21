import {afterEach, describe, expect, it} from "vitest";
import type {AddressInfo} from "node:net";
import type {Server} from "node:http";
import {createHealthServer, createInitialPollState, type HealthServerDeps} from "@/worker/health";

/**
 * "The endpoint responds" (WP4.17 B10). Binds port 0 (never the real `WORKER_HEALTH_PORT`) and
 * supplies stub `HealthServerDeps` so this never touches a real Mongo connection - see
 * `src/worker/health.ts`'s own doc comment on why those dependencies are injectable.
 */

const stubDeps: HealthServerDeps = {
  checkMongoConnectivity: async () => true,
  getActivityFollowerCursorBlock: async () => 42,
  getPaymentWatcherChainCursors: async () => [
    {chainKey: "ethereum", cursorBlock: 1},
    {chainKey: "base", cursorBlock: 2},
    {chainKey: "sepolia", cursorBlock: null},
    {chainKey: "baseSepolia", cursorBlock: null},
  ],
};

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

function listen(s: Server): Promise<number> {
  server = s;
  return new Promise((resolve) => {
    s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port));
  });
}

describe("worker health server", () => {
  it("answers 200 with an ok JSON body on GET /healthz when everything is fresh", async () => {
    const port = await listen(createHealthServer(createInitialPollState(), 10, stubDeps));
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.activityFollower.cursorBlock).toBe(42);
    expect(body.paymentWatcher.chains).toHaveLength(4);
  });

  it("answers 200 with an ok JSON body on GET /livez", async () => {
    const port = await listen(createHealthServer(createInitialPollState(), 10, stubDeps));
    const res = await fetch(`http://127.0.0.1:${port}/livez`);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  it("answers 503 on /healthz when the injected mongo check reports unreachable", async () => {
    const port = await listen(
      createHealthServer(createInitialPollState(), 10, {...stubDeps, checkMongoConnectivity: async () => false}),
    );
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.reasons).toContain("mongo unreachable");
  });

  it("answers 200 on /livez even when mongo is unreachable (liveness never checks mongo)", async () => {
    const port = await listen(
      createHealthServer(createInitialPollState(), 10, {...stubDeps, checkMongoConnectivity: async () => false}),
    );
    const res = await fetch(`http://127.0.0.1:${port}/livez`);
    expect(res.status).toBe(200);
  });

  it("answers 404 for an unknown path", async () => {
    const port = await listen(createHealthServer(createInitialPollState(), 10, stubDeps));
    const res = await fetch(`http://127.0.0.1:${port}/not-a-real-route`);
    expect(res.status).toBe(404);
  });
});
