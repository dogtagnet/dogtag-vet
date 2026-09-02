import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

// A transient connect failure must not poison the cached connection promise (2026-09-02 outage).
describe("connectToDatabase", () => {
  beforeEach(() => {
    vi.resetModules();
    delete (globalThis as {__dogtagVetMongoose?: unknown}).__dogtagVetMongoose;
    process.env.MONGODB_URI = "mongodb://127.0.0.1:1/unit-test";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as {__dogtagVetMongoose?: unknown}).__dogtagVetMongoose;
  });

  it("retries a fresh connect after a rejected one instead of re-awaiting the cached rejection", async () => {
    const connect = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValueOnce({ok: true});
    vi.doMock("mongoose", () => ({default: {connect}}));
    const {connectToDatabase} = await import("@/lib/db");

    await expect(connectToDatabase()).rejects.toThrow("ECONNREFUSED");
    await expect(connectToDatabase()).resolves.toEqual({ok: true});
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("reuses one successful connection (no reconnect per call)", async () => {
    const connect = vi.fn().mockResolvedValue({ok: true});
    vi.doMock("mongoose", () => ({default: {connect}}));
    const {connectToDatabase} = await import("@/lib/db");

    await connectToDatabase();
    await connectToDatabase();
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
