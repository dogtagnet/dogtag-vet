import {afterAll, afterEach, beforeAll, describe, expect, it} from "vitest";
import {randomUUID} from "node:crypto";
import mongoose from "mongoose";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";
import {connectToDatabase} from "@/lib/db";
import {DelegationSession} from "@/lib/models/DelegationSession";
import {loadOwnersCardData} from "@/lib/delegation/ownersCardData";

/**
 * WP4.15V grade round 1, D1 (MAJOR) - the actual bite. Before the fix, `chainActive` started as
 * `null` in the unconfigured case exactly like a genuine chain-read FAILURE, so `chainVerified`
 * (`chainActive !== null`) came out `false` here too - the Owners card then rendered "Could not
 * verify current secondary owners - the chain could not be reached just now" directly above "Multi-
 * owner tags are not configured on this deployment yet", one contradictory card, live on Kenneth's
 * own UAT deployment today (`dogtag-vet/.env.local` has no `DELEGATION_REGISTRY_ADDRESS` at all).
 * The grade file's own verification recipe calls this out as needing a unit test specifically
 * BECAUSE no e2e test can reach it: `playwright.config.ts:73` always sets the variable for the
 * whole e2e run, so this module-level test is the ONLY place "unconfigured" is ever exercised.
 *
 * This file never sets `DELEGATION_REGISTRY_ADDRESS` - the `delete` in `beforeAll` is defensive
 * (protects this file's result even if some earlier file sharing this worker process left the real
 * OS-level `process.env` polluted; Vitest's default `isolate: true` still gives this file its own
 * fresh `@/lib/env` module instance and thus its own fresh `cached`, so once deleted here, before
 * any `requireEnv` call in this file, "unset" is what `loadOwnersCardData` will see for its entire
 * run). See the sibling `ownersCardDataChainConfigured.integration.test.ts` for the CONFIGURED half
 * of this same pin, and its doc comment for the fuller two-files-not-two-`describe`s rationale.
 *
 * ISOLATION: own ephemeral mongod on a freshly OS-reserved free port (see
 * tests/unit/helpers/ephemeralMongod.ts - each spawn reserves a currently-free port by binding
 * and releasing a throwaway socket, unique across concurrent processes including two whole
 * copies of this suite running at once, and retries on a genuine bind collision, so no fixed
 * port or manual coordination between sibling suites is needed).
 */
let ephemeral: EphemeralMongod;

beforeAll(async () => {
  delete process.env.DELEGATION_REGISTRY_ADDRESS;
  ephemeral = await startEphemeralMongod("dogtag-vet-owners-card-unconfigured");
  process.env.MONGODB_URI = ephemeral.uri;
  await connectToDatabase();
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(ephemeral.port);
}, 90_000);

afterAll(async () => {
  await mongoose.connection.close();
  await stopEphemeralMongod(ephemeral);
});

afterEach(async () => {
  await DelegationSession.deleteMany({});
});

describe("loadOwnersCardData - registry NOT configured (grade round 1 D1's own bite)", () => {
  it("reports chainVerified true and delegationConfigured false, with no secondaries - never the 'could not verify' state", async () => {
    const data = await loadOwnersCardData(randomUUID(), "333333", undefined);

    expect(data.delegationConfigured).toBe(false);
    expect(data.chainVerified).toBe(true); // the fix: unattempted must never read the same as failed
    expect(data.secondaries).toEqual([]);
  });

  it("a stale confirmed add from a clinic that WAS configured once fails in the safe direction: revoked, never active or active_unverified", async () => {
    const dogTagIdField = "444444";
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
      commitment: `0x${"cc".repeat(32)}`,
      wallet: `0x${"1".repeat(40)}`,
      issuedAt: now - 60,
      blockNumber: 1,
      deadline: now + 600,
      status: "confirmed",
      consumed: true,
      consumedAt: now - 30,
    });

    const data = await loadOwnersCardData(randomUUID(), dogTagIdField, undefined);

    expect(data.delegationConfigured).toBe(false);
    expect(data.chainVerified).toBe(true); // still no contradictory banner
    expect(data.secondaries).toHaveLength(1);
    expect(data.secondaries[0]!.status).toBe("revoked"); // the one edge case ownersCardData.ts's own doc comment discloses - proven here, not just asserted
  });
});
