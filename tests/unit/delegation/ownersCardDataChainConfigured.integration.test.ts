import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import {randomUUID} from "node:crypto";
import mongoose from "mongoose";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * WP4.15V grade round 1, D1 (MAJOR) - half of the fix's own required coverage. The grade file's
 * verification recipe for D1 says explicitly: "Add a unit test over `loadOwnersCardData` (or the
 * banner predicate) pinning unconfigured-is-not-unverified; no e2e can catch this today because
 * `playwright.config.ts:73` always sets the variable, so the defect and its coverage gap are one
 * finding." This file covers the CONFIGURED half of that pin (both of `chainVerified`'s true
 * outcomes while `DELEGATION_REGISTRY_ADDRESS` IS set); the sibling file
 * `ownersCardDataUnconfigured.integration.test.ts` covers the unconfigured half. They are two files,
 * not two `describe` blocks in one, because `getServerEnv()` (`src/lib/env.ts:130-140`) parses
 * `process.env` once per module instance and caches the result for every later `requireEnv` call in
 * that instance - `delete`-ing the var mid-file after some earlier test already triggered that cache
 * (e.g. via `connectToDatabase()`) would silently keep testing the already-cached, already-configured
 * branch. Vitest's default `isolate: true` (unchanged in this repo's `vitest.config.ts`) gives every
 * test FILE a fresh module graph and therefore a fresh `cached`, so two files each get one honest,
 * uncontaminated shot at the module-load-time state they need - the same reason every other
 * integration test in this suite is one concern per file.
 *
 * ISOLATION: own ephemeral mongod, port 44140 (44139 is delegationStatusBundle's own port, the
 * previous D3 fix in this same round - see that file's doc comment for the fuller port ledger).
 */
vi.mock("@/lib/chainRead", async () => {
  const actual = await vi.importActual<typeof import("@/lib/chainRead")>("@/lib/chainRead");
  return {...actual, readDelegationLeaves: vi.fn()};
});

import {readDelegationLeaves} from "@/lib/chainRead";
import {connectToDatabase} from "@/lib/db";
import {DelegationSession} from "@/lib/models/DelegationSession";
import {loadOwnersCardData} from "@/lib/delegation/ownersCardData";

const MONGO_PORT = 44_140;
let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-owners-card-configured");
  process.env.MONGODB_URI = ephemeral.uri;
  process.env.DELEGATION_REGISTRY_ADDRESS = `0x${"5".repeat(40)}`;
  await connectToDatabase();
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(MONGO_PORT);
}, 30_000);

afterAll(async () => {
  await mongoose.connection.close();
  await stopEphemeralMongod(ephemeral);
  delete process.env.DELEGATION_REGISTRY_ADDRESS;
});

afterEach(async () => {
  await DelegationSession.deleteMany({});
  vi.mocked(readDelegationLeaves).mockReset();
});

async function seedConfirmedAdd(dogTagIdField: string, commitment: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await DelegationSession.create({
    token: randomUUID().replace(/-/g, "").slice(0, 32),
    registrationId: randomUUID(),
    kind: "add",
    petId: randomUUID(),
    dogTagIdField,
    clientId: randomUUID(),
    clinic: "0x7b9bf16f0e39adf8c38d8491f4c7e9c17e85d703",
    chainId: 135,
    clinicName: "Example Vet Clinic",
    maskedTargetName: "J***** R******",
    commitment: commitment.toLowerCase(),
    wallet: `0x${"1".repeat(40)}`,
    issuedAt: now - 60,
    blockNumber: 1,
    deadline: now + 600,
    status: "confirmed",
    consumed: true,
    consumedAt: now - 30,
  });
}

function sixteenSlots(activeCommitment: `0x${string}`): `0x${string}`[] {
  const zero = `0x${"0".repeat(64)}` as const;
  const slots: `0x${string}`[] = Array.from({length: 16}, () => zero);
  slots[0] = activeCommitment;
  return slots;
}

describe("loadOwnersCardData - registry CONFIGURED (grade round 1 D1)", () => {
  it("a successful chain read reports chainVerified true and shows the row as active, never active_unverified", async () => {
    const dogTagIdField = "111111";
    const commitment = `0x${"aa".repeat(32)}` as `0x${string}`;
    await seedConfirmedAdd(dogTagIdField, commitment);
    vi.mocked(readDelegationLeaves).mockResolvedValue(sixteenSlots(commitment));

    const data = await loadOwnersCardData(randomUUID(), dogTagIdField, undefined);

    expect(data.delegationConfigured).toBe(true);
    expect(data.chainVerified).toBe(true);
    expect(data.secondaries).toHaveLength(1);
    expect(data.secondaries[0]!.status).toBe("active");
  });

  it("a chain read that throws reports chainVerified false (the ONE state this banner is actually for) and suffixes the row _unverified", async () => {
    const dogTagIdField = "222222";
    const commitment = `0x${"bb".repeat(32)}` as `0x${string}`;
    await seedConfirmedAdd(dogTagIdField, commitment);
    vi.mocked(readDelegationLeaves).mockRejectedValue(new Error("RPC unreachable"));

    const data = await loadOwnersCardData(randomUUID(), dogTagIdField, undefined);

    expect(data.delegationConfigured).toBe(true);
    expect(data.chainVerified).toBe(false);
    expect(data.secondaries).toHaveLength(1);
    expect(data.secondaries[0]!.status).toBe("active_unverified");
  });
});
