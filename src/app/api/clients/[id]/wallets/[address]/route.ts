import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Client, type ClientDoc} from "@/lib/models/Client";
import {walletLabelSchema} from "@/lib/schemas/walletRegistration";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";

/**
 * `PATCH /api/clients/:id/wallets/:address {label}` - staff label edit for an already-registered
 * wallet. Not in the spec's literal staff-routes enumeration (which names create/status/revoke),
 * but required by its own UI section ("registered wallets list ... label edit") and a natural
 * sibling of the revoke route below, which already establishes this `.../wallets/:address`
 * resource path. An empty/blank label clears it (`$unset`) rather than persisting `""`.
 */
export async function PATCH(request: Request, {params}: {params: Promise<{id: string; address: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id, address} = await params;
  const body = await request.json().catch(() => null);
  const parsed = walletLabelSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed label payload.", parsed.error.flatten());

  await connectToDatabase();
  const addressLower = address.toLowerCase();
  const label = parsed.data.label?.trim();
  const updated = await Client.findOneAndUpdate(
    {clientId: id, "wallets.address": addressLower},
    label ? {$set: {"wallets.$.label": label}} : {$unset: {"wallets.$.label": ""}},
    {new: true},
  ).lean<ClientDoc>();
  if (!updated) return notFound("Wallet not found for this client.");

  const wallet = updated.wallets.find((w) => w.address === addressLower);
  return NextResponse.json(wallet);
}
