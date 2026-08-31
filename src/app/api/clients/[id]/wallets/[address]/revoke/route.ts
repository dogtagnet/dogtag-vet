import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Client, type ClientDoc} from "@/lib/models/Client";
import {notFound, requireStaffSession} from "@/lib/staffApi";

/**
 * `POST /api/clients/:id/wallets/:address/revoke` - plans/wp4.2-client-wallet-registration.md,
 * "staff can revoke (bookkeeping flag - the receipt is never deleted)". Idempotent: a repeat call
 * against an already-revoked wallet leaves its original `revokedAt` untouched rather than
 * re-stamping it, and still answers 200 with the wallet's current state.
 */
export async function POST(_request: Request, {params}: {params: Promise<{id: string; address: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id, address} = await params;
  await connectToDatabase();
  const addressLower = address.toLowerCase();
  const now = Math.floor(Date.now() / 1000);

  await Client.findOneAndUpdate(
    {clientId: id, "wallets.address": addressLower, "wallets.revokedAt": {$exists: false}},
    {$set: {"wallets.$.revokedAt": now}},
  );

  const client = await Client.findOne({clientId: id}).lean<ClientDoc>();
  if (!client) return notFound("Client not found.");
  const wallet = client.wallets.find((w) => w.address === addressLower);
  if (!wallet) return notFound("Wallet not found for this client.");

  return NextResponse.json(wallet);
}
