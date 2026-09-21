import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import mongoose from "mongoose";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * WP4.18 V4 - `POST /api/payments` end to end against the REAL route handler + a real ephemeral
 * mongod (never the live manual-E2E database on 127.0.0.1:27500): a rail without a manual rate
 * cannot be created, and one with a rate builds a real crypto rail with no live price feed ever
 * consulted (there is none left to consult - `src/lib/payments/priceFeed.ts` was deleted in V1).
 *
 * ISOLATION: own ephemeral mongod, port 44147 (44117-44146 already taken by sibling suites - see
 * `tests/unit/api/selfWalletRoute.integration.test.ts`'s own doc comment for the running registry).
 */
vi.mock("@/auth", () => ({auth: vi.fn()}));

import {auth} from "@/auth";
import {connectToDatabase} from "@/lib/db";
import {POST} from "@/app/api/payments/route";
import {ClinicSettings} from "@/lib/models/ClinicSettings";
import {Payment} from "@/lib/models/Payment";
import {AmountReservation} from "@/lib/models/AmountReservation";

const MONGO_PORT = 44_147;
let ephemeral: EphemeralMongod;
const RECEIVING = "0x" + "6".repeat(40);

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-payments-manual-rate");
  process.env.MONGODB_URI = ephemeral.uri;
  await connectToDatabase();
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(MONGO_PORT);
  expect(mongoose.connection.name).toBe("dogtag-vet-payments-manual-rate");
}, 90_000);

afterAll(async () => {
  await mongoose.connection.close();
  await stopEphemeralMongod(ephemeral);
});

afterEach(async () => {
  await Promise.all([ClinicSettings.deleteMany({}), Payment.deleteMany({}), AmountReservation.deleteMany({})]);
  vi.mocked(auth).mockReset();
});

function staffSession() {
  vi.mocked(auth).mockResolvedValue({user: {staffId: "staff-1", email: "staff@example.com"}} as never);
}

function postRequest(body: unknown) {
  return new Request("http://localhost/api/payments", {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify(body),
  });
}

const BASE_PAYLOAD = {
  lineItems: [{description: "Checkup", qty: 1, unitAmount: "75.00"}],
  currency: "USD",
};

describe("POST /api/payments - manual-rate-only ROAX rails", () => {
  it("400s (malformed request) when an accepted rail has no manualRate - never allocates an invoice number", async () => {
    staffSession();
    await ClinicSettings.create({_id: "singleton", receivingAddresses: [{chainKey: "roax", address: RECEIVING}]});

    const res = await POST(postRequest({...BASE_PAYLOAD, acceptedRails: [{chainKey: "roax", token: "PLASMA"}]}));
    expect(res.status).toBe(400);
    expect(await Payment.countDocuments({})).toBe(0);
  });

  it("creates a real PLASMA rail from the manual rate alone, with no live price feed involved", async () => {
    staffSession();
    await ClinicSettings.create({_id: "singleton", receivingAddresses: [{chainKey: "roax", address: RECEIVING}]});

    const res = await POST(
      postRequest({...BASE_PAYLOAD, acceptedRails: [{chainKey: "roax", token: "PLASMA", manualRate: "2500.00"}]}),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.crypto).toHaveLength(1);
    expect(body.crypto[0].chainKey).toBe("roax");
    expect(body.crypto[0].token).toBe("PLASMA");
    expect(body.crypto[0].quotedRate).toBe("2500.00");
    expect(body.crypto[0].receivingAddress.toLowerCase()).toBe(RECEIVING);
    expect(body.crypto[0].eip681).toMatch(/^ethereum:/);
  });

  it("creates both a PLASMA and a RUSD rail on the same invoice, each with its own manual rate", async () => {
    staffSession();
    await ClinicSettings.create({_id: "singleton", receivingAddresses: [{chainKey: "roax", address: RECEIVING}]});

    const res = await POST(
      postRequest({
        ...BASE_PAYLOAD,
        acceptedRails: [
          {chainKey: "roax", token: "PLASMA", manualRate: "2500.00"},
          {chainKey: "roax", token: "RUSD", manualRate: "1.00"},
        ],
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.crypto).toHaveLength(2);
    const tokens = body.crypto.map((r: {token: string}) => r.token).sort();
    expect(tokens).toEqual(["PLASMA", "RUSD"]);
  });
});
