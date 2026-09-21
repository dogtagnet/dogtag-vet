import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import mongoose from "mongoose";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * WP4.18 V3 - `GET /api/payments/rails` against the REAL route handler + a real ephemeral mongod
 * (never the live manual-E2E database on 127.0.0.1:27500), proving the rails listing is exactly
 * ROAX's own two-token list (PLASMA, RUSD), never a cross product with any other chain.
 *
 * ISOLATION: own ephemeral mongod, port 44146 (44117-44145 already taken by sibling suites - see
 * `tests/unit/api/selfWalletRoute.integration.test.ts`'s own doc comment for the running registry,
 * and its WP4.17A D7 note on why a collision is a real, previously-reproduced hazard here, not a
 * theoretical one).
 */
vi.mock("@/auth", () => ({auth: vi.fn()}));

import {auth} from "@/auth";
import {connectToDatabase} from "@/lib/db";
import {GET} from "@/app/api/payments/rails/route";
import {ClinicSettings} from "@/lib/models/ClinicSettings";

const MONGO_PORT = 44_146;
let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-payments-rails");
  process.env.MONGODB_URI = ephemeral.uri;
  await connectToDatabase();
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(MONGO_PORT);
  expect(mongoose.connection.name).toBe("dogtag-vet-payments-rails");
}, 90_000);

afterAll(async () => {
  await mongoose.connection.close();
  await stopEphemeralMongod(ephemeral);
});

afterEach(async () => {
  await ClinicSettings.deleteMany({});
  vi.mocked(auth).mockReset();
});

function staffSession() {
  vi.mocked(auth).mockResolvedValue({user: {staffId: "staff-1", email: "staff@example.com"}} as never);
}

describe("GET /api/payments/rails", () => {
  it("401s with no staff session", async () => {
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("lists exactly PLASMA and RUSD on roax - never a cross product with any other chain", async () => {
    staffSession();
    const res = await GET();
    expect(res.status).toBe(200);
    const rails = await res.json();

    // The whole point of wp4.18's "no cross product": exactly 2 entries (one chain x its own
    // 2-token list), never 4 chains x 3 tokens = 12, and never any pairing with a token roax
    // does not declare.
    expect(rails).toHaveLength(2);
    expect(rails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({chainKey: "roax", token: "PLASMA"}),
        expect.objectContaining({chainKey: "roax", token: "RUSD"}),
      ]),
    );
    for (const rail of rails) expect(rail.chainKey).toBe("roax");
  });

  it("reports receivingAddressConfigured true once a roax receiving address is set in Settings", async () => {
    staffSession();
    await ClinicSettings.create({_id: "singleton", receivingAddresses: [{chainKey: "roax", address: "0x" + "5".repeat(40)}]});

    const res = await GET();
    const rails = await res.json();
    for (const rail of rails) expect(rail.receivingAddressConfigured).toBe(true);
  });

  it("reports RUSD as placeholder (no TOKEN_RUSD_ROAX_ADDRESS override in this test env) and PLASMA as never a placeholder", async () => {
    staffSession();
    const res = await GET();
    const rails: {chainKey: string; token: string; placeholder: boolean}[] = await res.json();

    const plasma = rails.find((r) => r.token === "PLASMA");
    const rusd = rails.find((r) => r.token === "RUSD");
    expect(plasma?.placeholder).toBe(false);
    expect(rusd?.placeholder).toBe(true);
  });
});
