import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Payment} from "@/lib/models/Payment";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {nextSequence} from "@/lib/models/Counter";
import {createPaymentSchema} from "@/lib/schemas/payment";
import {badRequest, requireStaffSession} from "@/lib/staffApi";
import {getServerEnv} from "@/lib/env";
import {buildCryptoRail} from "@/lib/payments/buildRail";
import {releaseReservationsForPayment} from "@/lib/payments/reservations";
import {allocateInvoiceNumber} from "@/lib/payments/invoiceNumber";
import {sumLineItems, lineItemAmount, buildTaxLine, addAmounts} from "@/lib/payments/money";
import {randomUUID} from "node:crypto";

/**
 * `POST /api/payments` - staff-only invoice creation (not part of `vet-public-api.yaml`; that spec
 * only covers the public payment-status/receipt surface). Every fiat amount is recomputed
 * server-side from `lineItems` (`src/lib/payments/money.ts`) rather than trusted from the client.
 *
 * ROAX rails are manual-rate only (plans/wp4.18-roax-payments.md section 7: "rates are manual
 * only") - there is no live price feed to fall back to, so `manualRate` is a REQUIRED field on
 * every accepted rail (`createPaymentSchema`), checked here before any allocation (invoice number,
 * dust reservations), same "preflight before allocate" ordering as tag issuance. A missing rate
 * never reaches this route at all: `createPaymentSchema.safeParse` already rejects it with a plain
 * `400` (there is no live-quote retry path left to recover from, so the old two-step
 * `manual_rate_required` 409 dance this route used to need is gone).
 */
export async function POST(request: Request) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const body = await request.json().catch(() => null);
  const parsed = createPaymentSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed payment request.", parsed.error.flatten());
  const input = parsed.data;

  await connectToDatabase();
  const settings = await getClinicSettings();

  // Recompute every fiat figure server-side.
  const lineItems = input.lineItems.map((item) => ({
    description: item.description,
    qty: item.qty,
    unitAmount: item.unitAmount,
    amount: lineItemAmount(item.unitAmount, item.qty),
  }));
  const subtotal = sumLineItems(lineItems);
  const tax = input.tax ? buildTaxLine(subtotal, input.tax.label, input.tax.rate) : undefined;
  const total = tax ? addAmounts(subtotal, tax.amount) : subtotal;

  // Every accepted rail needs a configured receiving address - a rail this deployment has no
  // address for fails the whole request cleanly, before anything durable is allocated.
  const missingReceivingAddress: string[] = [];
  const resolvedRails: {chainKey: (typeof input.acceptedRails)[number]["chainKey"]; token: (typeof input.acceptedRails)[number]["token"]; rate: string; receivingAddress: string}[] = [];

  for (const rail of input.acceptedRails) {
    const receiving = settings.receivingAddresses.find((r) => r.chainKey === rail.chainKey)?.address;
    if (!receiving) {
      missingReceivingAddress.push(rail.chainKey);
      continue;
    }
    resolvedRails.push({chainKey: rail.chainKey, token: rail.token, rate: rail.manualRate, receivingAddress: receiving});
  }

  if (missingReceivingAddress.length > 0) {
    return badRequest(
      `No receiving address configured for: ${missingReceivingAddress.join(", ")}. Set one in Settings before accepting this rail.`,
    );
  }

  const paymentId = randomUUID();
  const crypto = [];
  try {
    for (const rail of resolvedRails) {
      crypto.push(
        await buildCryptoRail({
          paymentId,
          chainKey: rail.chainKey,
          token: rail.token,
          fiatTotal: total,
          quotedRate: rail.rate,
          receivingAddress: rail.receivingAddress,
        }),
      );
    }
  } catch (err) {
    // A later rail's dust reservation can fail (see `DustExhaustedError`) after an earlier rail in
    // this same loop already succeeded - release those before this request fails, or they would
    // sit claimed forever against a `paymentId` that never becomes a real `Payment` document (no
    // `cancel`/expiry-sweep path will ever find and release them otherwise).
    await releaseReservationsForPayment(paymentId);
    throw err;
  }

  const invoiceNumber = await allocateInvoiceNumber(
    {nextHandle: () => nextSequence("invoiceNumber")},
    getServerEnv().INVOICE_NUMBER_PREFIX,
  );

  const payment = await Payment.create({
    paymentId,
    invoiceNumber,
    clientId: input.clientId,
    petId: input.petId,
    appointmentId: input.appointmentId,
    lineItems,
    currency: input.currency,
    subtotal,
    tax,
    total,
    status: "pending",
    dueAt: input.dueAt,
    crypto,
    notes: input.notes,
  });

  return NextResponse.json(payment.toObject(), {status: 201});
}
