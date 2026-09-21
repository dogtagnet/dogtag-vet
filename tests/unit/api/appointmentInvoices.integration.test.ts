import {afterAll, afterEach, beforeAll, describe, expect, it} from "vitest";
import mongoose from "mongoose";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * WP4.18 fix round 1 (vet), D1 - `GET /v1/booking/appointments/{id}`'s `invoices[].tokenSymbols`
 * against the REAL route handler + a real ephemeral mongod (never the live manual-E2E database on
 * 127.0.0.1:27500).
 *
 * `tokenSymbols` must be `[]` once an invoice is no longer `pending` (settled/paid, cancelled, or
 * expired) - the route previously emitted every rail's token symbol in EVERY status, so a Paid
 * invoice rendered on the phone as if it still had an open PLASMA/RUSD rail to pay. Fixed by
 * gating on `p.status === "pending"`, the same condition `wire.ts`'s `toPaymentPublicStatusResponse`
 * already uses for its own `rails` field.
 *
 * ISOLATION: own ephemeral mongod, port 44149 (44117-44148 already taken by sibling suites - see
 * `tests/unit/api/selfWalletRoute.integration.test.ts`'s own doc comment for the running registry).
 */

import {connectToDatabase} from "@/lib/db";
import {GET} from "@/app/v1/booking/appointments/[id]/route";
import {Appointment} from "@/lib/models/Appointment";
import {Payment, type CryptoRail} from "@/lib/models/Payment";

const MONGO_PORT = 44_149;
let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-appointment-invoices");
  process.env.MONGODB_URI = ephemeral.uri;
  await connectToDatabase();
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(MONGO_PORT);
  expect(mongoose.connection.name).toBe("dogtag-vet-appointment-invoices");
}, 90_000);

afterAll(async () => {
  await mongoose.connection.close();
  await stopEphemeralMongod(ephemeral);
});

afterEach(async () => {
  await Promise.all([Appointment.deleteMany({}), Payment.deleteMany({})]);
});

function rail(overrides: Partial<CryptoRail> = {}): CryptoRail {
  return {
    chainKey: "roax",
    token: "PLASMA",
    decimals: 18,
    quotedRate: "3000.00",
    amountBase: "25000000000000000",
    receivingAddress: "0x" + "a".repeat(40),
    eip681: `ethereum:0x${"a".repeat(40)}@135?value=25000000000000000`,
    ...overrides,
  };
}

async function createAppointment(cancelToken: string) {
  const now = Math.floor(Date.now() / 1000);
  return Appointment.create({
    clientName: "Jane Doe",
    petName: "Rex",
    startAt: now + 3600,
    endAt: now + 5400,
    source: "staff",
    cancelToken,
  });
}

function fetchAppointment(appointmentId: string, token: string) {
  return GET(new Request(`http://localhost/v1/booking/appointments/${appointmentId}?token=${token}`), {
    params: Promise.resolve({id: appointmentId}),
  });
}

describe("GET /v1/booking/appointments/{id} - invoices[].tokenSymbols (WP4.18 fix round 1, D1)", () => {
  it("carries both rails while pending, and is [] once paid", async () => {
    const appointment = await createAppointment("cancel-tok-d1");

    await Payment.create({
      invoiceNumber: "INV-D1-PENDING",
      appointmentId: appointment.appointmentId,
      lineItems: [],
      currency: "USD",
      subtotal: "75.00",
      total: "75.00",
      status: "pending",
      crypto: [rail({token: "PLASMA"}), rail({token: "RUSD", tokenAddress: "0x" + "9".repeat(40)})],
    });
    await Payment.create({
      invoiceNumber: "INV-D1-PAID",
      appointmentId: appointment.appointmentId,
      lineItems: [],
      currency: "USD",
      subtotal: "20.00",
      total: "20.00",
      status: "paid",
      crypto: [rail({token: "PLASMA"})],
    });

    const res = await fetchAppointment(appointment.appointmentId, "cancel-tok-d1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.invoices).toHaveLength(2);

    const pending = body.invoices.find((invoice: {status: string}) => invoice.status === "pending");
    const paid = body.invoices.find((invoice: {status: string}) => invoice.status === "paid");
    expect(pending.tokenSymbols).toEqual(["PLASMA", "RUSD"]);
    // The bug this regression test bites: the route used to emit `p.crypto.map(...)`
    // unconditionally, so a Paid invoice (still carrying its now-meaningless `crypto` rails)
    // rendered as `["PLASMA"]` here instead of `[]`.
    expect(paid.tokenSymbols).toEqual([]);
  });

  it("is also [] for a cancelled or an expired invoice, even though crypto[] is non-empty", async () => {
    const appointment = await createAppointment("cancel-tok-d1b");

    await Payment.create({
      invoiceNumber: "INV-D1-CANCELLED",
      appointmentId: appointment.appointmentId,
      lineItems: [],
      currency: "USD",
      subtotal: "10.00",
      total: "10.00",
      status: "cancelled",
      crypto: [rail({token: "PLASMA"})],
    });
    await Payment.create({
      invoiceNumber: "INV-D1-EXPIRED",
      appointmentId: appointment.appointmentId,
      lineItems: [],
      currency: "USD",
      subtotal: "11.00",
      total: "11.00",
      status: "expired",
      crypto: [rail({token: "RUSD", tokenAddress: "0x" + "9".repeat(40)})],
    });

    const res = await fetchAppointment(appointment.appointmentId, "cancel-tok-d1b");
    const body = await res.json();
    for (const invoice of body.invoices) {
      expect(invoice.tokenSymbols).toEqual([]);
    }
  });
});
