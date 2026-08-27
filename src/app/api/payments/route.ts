import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Payment} from "@/lib/models/Payment";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {nextSequence} from "@/lib/models/Counter";
import {createPaymentSchema} from "@/lib/schemas/payment";
import {badRequest, requireStaffSession} from "@/lib/staffApi";
import {getServerEnv} from "@/lib/env";
import {getSpotRate} from "@/lib/payments/priceFeed";
import {buildCryptoRail} from "@/lib/payments/buildRail";
import {releaseReservationsForPayment} from "@/lib/payments/reservations";
import {allocateInvoiceNumber} from "@/lib/payments/invoiceNumber";
import {sumLineItems, lineItemAmount, buildTaxLine, addAmounts} from "@/lib/payments/money";
import {randomUUID} from "node:crypto";

/**
 * `POST /api/payments` - staff-only invoice creation (not part of `vet-public-api.yaml`; that spec
 * only covers the public payment-status/receipt surface). Every fiat amount is recomputed
 * server-side from `lineItems` (`src/lib/payments/money.ts`) rather than trusted from the client,
 * and every accepted crypto rail is quoted server-side too - the client only says WHICH rails to
 * accept and, optionally, a manual rate to use if the live quote is unavailable.
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

  // Resolve a fiat-per-token rate for every accepted rail before allocating anything durable
  // (invoice number, dust reservations) - a rail this deployment can't quote or configure a
  // receiving address for fails the whole request cleanly, same "preflight before allocate"
  // ordering as tag issuance.
  const env = getServerEnv();
  const needsManualRate: {chainKey: string; token: string}[] = [];
  const missingReceivingAddress: string[] = [];
  const resolvedRails: {chainKey: (typeof input.acceptedRails)[number]["chainKey"]; token: (typeof input.acceptedRails)[number]["token"]; rate: string; receivingAddress: string}[] = [];

  for (const rail of input.acceptedRails) {
    const receiving = settings.receivingAddresses.find((r) => r.chainKey === rail.chainKey)?.address;
    if (!receiving) {
      missingReceivingAddress.push(rail.chainKey);
      continue;
    }

    const quote = await getSpotRate(
      {fetchImpl: fetch, now: Date.now(), apiBase: env.COINGECKO_API_BASE},
      rail.token,
      input.currency,
    );
    const rate = quote.ok ? quote.rate : (quote.staleRate ?? rail.manualRate);
    if (!rate) {
      needsManualRate.push({chainKey: rail.chainKey, token: rail.token});
      continue;
    }
    resolvedRails.push({chainKey: rail.chainKey, token: rail.token, rate, receivingAddress: receiving});
  }

  if (missingReceivingAddress.length > 0) {
    return badRequest(
      `No receiving address configured for: ${missingReceivingAddress.join(", ")}. Set one in Settings before accepting this rail.`,
    );
  }
  if (needsManualRate.length > 0) {
    return NextResponse.json(
      {
        error: {
          code: "manual_rate_required",
          message: "A live rate could not be fetched for one or more rails. Enter a manual rate to continue.",
          details: {rails: needsManualRate},
        },
      },
      {status: 409},
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

  const invoiceNumber = await allocateInvoiceNumber({nextHandle: () => nextSequence("invoiceNumber")}, env.INVOICE_NUMBER_PREFIX);

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
