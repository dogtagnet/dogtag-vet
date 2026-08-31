import "server-only";
import {Client, buildClientSearchKey, type ClientDoc, type ClientWallet} from "@/lib/models/Client";

/**
 * Client match-or-create for public booking, per wp4-vet.md: match an existing client by email or
 * phone (email first, since it's required on every booking; phone as a secondary match for a
 * client who's booked before under a different email), or create a new one. Never updates an
 * existing client's name/phone from the booking form - a public booking is not an invitation for
 * an anonymous caller to silently overwrite a clinic's own CRM record.
 */
export async function findOrCreateClientForBooking(client: {
  name: string;
  email: string;
  phone?: string;
}): Promise<ClientDoc> {
  const email = client.email.trim().toLowerCase();
  const existing = await Client.findOne({
    $or: [{email}, ...(client.phone ? [{phone: client.phone.trim()}] : [])],
  }).lean<ClientDoc>();
  if (existing) return existing;

  const created = await Client.create({
    name: client.name.trim(),
    email,
    phone: client.phone?.trim(),
    petIds: [],
    searchKey: buildClientSearchKey({name: client.name, email, phone: client.phone}),
  });
  return created.toObject();
}

/**
 * WP4.4 Q1's client-resolution order: "verified wallet match against Client.wallets[] FIRST, else
 * today's email-then-phone clientMatch, else create." Only a VERIFIED wallet address is ever
 * matched on - an unverified claim is never passed in here at all (an invalid signature rejects
 * the whole booking per Q2, before client resolution ever runs). Excludes revoked wallet entries
 * from the match: a revoked wallet's key may have been revoked BECAUSE it was compromised, so
 * possession of a signature from it must not still resolve to the client that once owned it.
 */
export async function findOrCreateClientForMobileBooking(input: {
  verifiedWalletAddress?: string;
  client: {name: string; email: string; phone?: string};
}): Promise<ClientDoc> {
  if (input.verifiedWalletAddress) {
    const walletMatch = await Client.findOne({
      wallets: {$elemMatch: {address: input.verifiedWalletAddress, revokedAt: {$exists: false}}},
    }).lean<ClientDoc>();
    if (walletMatch) return walletMatch;
  }
  return findOrCreateClientForBooking(input.client);
}

/** Does `client` already carry `walletAddress` in its `wallets[]`, active or revoked? Used to
 * decide whether Q1's auto-attach has anything to do - re-attaching an address already on file
 * (whichever path put it there) would violate `wallets[]`'s own "unique per client" invariant. */
export function clientAlreadyHasWallet(client: Pick<ClientDoc, "wallets">, walletAddress: string): boolean {
  return client.wallets.some((w) => w.address.toLowerCase() === walletAddress.toLowerCase());
}

/**
 * Q1's auto-attach write: appends a booking-sourced (`via: "booking"`) wallet entry to
 * `clientId`'s `wallets[]` - the SAME atomic "push unless this address is already present" idiom
 * `lib/registration/mongoStore.ts`'s `appendWalletToClient` uses (a single `findOneAndUpdate` with
 * `"wallets.address": {$ne: ...}` in the match filter, so there is no separate check-then-push race
 * window). Returns whether it actually appended - `false` (a lost race, or `clientAlreadyHasWallet`
 * was stale by the time this ran) is not an error the caller needs to act on: the wallet ends up
 * attached to the client either way.
 */
export async function appendBookingWalletToClient(clientId: string, entry: ClientWallet): Promise<boolean> {
  const updated = await Client.findOneAndUpdate(
    {clientId, "wallets.address": {$ne: entry.address}},
    {$push: {wallets: entry}},
    {new: true},
  ).lean<ClientDoc>();
  return Boolean(updated);
}
