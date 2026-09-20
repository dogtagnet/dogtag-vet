import {afterAll, beforeAll, describe, expect, it} from "vitest";
import mongoose, {Schema} from "mongoose";
import {assertWalletActuallyPushed} from "@/lib/models/Client";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * WP4.5 track3-sig - the forensic repro, verbatim (plans/wp4.5-track3sig-plan.md fix 4): a
 * long-lived dev process's cached `Client` model predated WP4.2's `wallets[]` field, so
 * mongoose's strict-mode update-path casting silently dropped a `$push: {wallets: entry}` while
 * `findOneAndUpdate` still reported a matched document - a false "ok" (see
 * `src/lib/models/registerModel.ts`'s fix for the general case this repro demonstrates).
 *
 * ISOLATION: this file connects to its OWN ephemeral `mongod` on a scratch port/dbpath - it never
 * reads `process.env.MONGODB_URI` (never calls `connectToDatabase()`/`requireEnv`) and never
 * touches the live manual-E2E database on 127.0.0.1:27500. The `expect(...).toContain("127.0.0.1")`
 * assertion right after connecting is a hard safety net against ever accidentally pointing this at
 * anything else.
 */

const REPRO_MONGO_PORT = 44_117; // >44000 per this track's isolation rule; ephemeral, this file's own.

let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(REPRO_MONGO_PORT, "dogtag-vet-stale-model-repro");

  // Hard safety net (never rely on construction alone): this process's global mongoose connection
  // must be OUR ephemeral instance, never anything read from the environment.
  await mongoose.connect(ephemeral.uri);
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(REPRO_MONGO_PORT);
  expect(mongoose.connection.name).toBe("dogtag-vet-stale-model-repro");
}, 90_000);

afterAll(async () => {
  await mongoose.disconnect();
  await stopEphemeralMongod(ephemeral);
});

interface OldClientDoc {
  clientId: string;
  name: string;
}

interface NewClientDoc {
  clientId: string;
  name: string;
  wallets: {address: string}[];
}

describe("the forensic repro (real mongod, real mongoose strict mode)", () => {
  it("a Client model registered BEFORE wallets[] existed silently drops the $push while findOneAndUpdate still reports a match", async () => {
    // Simulates the long-lived process's cached model: registered with the OLD (pre-WP4.2) shape,
    // deliberately bypassing getOrCreateModel - this is standing in for "whatever mechanism left a
    // schema-drifted model in mongoose.models", not re-testing registerModel.ts's own fix (that has
    // its own suite, tests/unit/models/registerModel.test.ts).
    const oldSchema = new Schema<OldClientDoc>({clientId: {type: String, required: true}, name: String});
    const OldClient = mongoose.model<OldClientDoc>("StaleRepro_OldClient", oldSchema, "stale_repro_clients");

    const created = await OldClient.create({clientId: "client-stale-1", name: "Marly"});
    expect(created.clientId).toBe("client-stale-1");

    const updated = await OldClient.findOneAndUpdate(
      {clientId: "client-stale-1", "wallets.address": {$ne: "0xabc"}},
      {$push: {wallets: {address: "0xabc"}}},
      {new: true, runValidators: true},
    ).lean();

    // The exact shape of the incident: a truthy, matched document (findOneAndUpdate did NOT
    // return null - the filter matched), yet the push never actually landed.
    expect(updated).toBeTruthy();
    expect((updated as OldClientDoc & {wallets?: unknown[]})?.wallets).toBeUndefined();
  });

  it("assertWalletActuallyPushed THROWS when fed that exact repro'd (matched-but-not-pushed) result", async () => {
    const oldSchema = new Schema<OldClientDoc>({clientId: {type: String, required: true}, name: String});
    const OldClient = mongoose.model<OldClientDoc>("StaleRepro_OldClient2", oldSchema, "stale_repro_clients_2");
    await OldClient.create({clientId: "client-stale-2", name: "Marly"});

    const updated = await OldClient.findOneAndUpdate(
      {clientId: "client-stale-2", "wallets.address": {$ne: "0xdef"}},
      {$push: {wallets: {address: "0xdef"}}},
      {new: true, runValidators: true},
    ).lean();

    expect(() => assertWalletActuallyPushed(updated as {wallets?: {address: string}[]} | null, "client-stale-2", "0xdef")).toThrow(
      /client-stale-2/,
    );
  });

  it("a FRESH model that actually knows about wallets[] pushes normally, and assertWalletActuallyPushed does not throw", async () => {
    const newSchema = new Schema<NewClientDoc>({
      clientId: {type: String, required: true},
      name: String,
      wallets: {type: [new Schema({address: String}, {_id: false})], default: []},
    });
    const NewClient = mongoose.model<NewClientDoc>("StaleRepro_NewClient", newSchema, "stale_repro_clients_3");
    await NewClient.create({clientId: "client-fresh-1", name: "Marly", wallets: []});

    const updated = await NewClient.findOneAndUpdate(
      {clientId: "client-fresh-1", "wallets.address": {$ne: "0x123"}},
      {$push: {wallets: {address: "0x123"}}},
      {new: true, runValidators: true},
    ).lean();

    expect(updated?.wallets).toEqual([{address: "0x123"}]);
    expect(() => assertWalletActuallyPushed(updated, "client-fresh-1", "0x123")).not.toThrow();
  });
});
