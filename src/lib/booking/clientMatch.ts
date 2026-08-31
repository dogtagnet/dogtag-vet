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

export interface WalletClientMatchPick {
  client: ClientDoc;
  /** More than one client record carries this active wallet - allowed state (WP4.2: "same wallet
   * MAY appear on different clients"), surfaced rather than silently picked over. */
  multiMatch: boolean;
}

/**
 * Review finding 6: deterministic selection among clients sharing one active wallet. A bare
 * `findOne` has no defined order, so the same household wallet on two client records resolved to
 * whichever document Mongo happened to return first - alternating bookings could split across the
 * two records. The pick is now total and stable: the client whose ACTIVE entry for this wallet has
 * the earliest `registeredAt` wins (the record that has known this wallet longest), ties broken by
 * `clientId`. Pure (no database) so it is unit-testable directly; the caller passes every match.
 */
export function pickDeterministicWalletClient(clients: ClientDoc[], walletAddress: string): WalletClientMatchPick | null {
  if (clients.length === 0) return null;
  const address = walletAddress.toLowerCase();
  const earliestActiveRegistration = (client: ClientDoc): number => {
    const times = client.wallets
      .filter((w) => w.address.toLowerCase() === address && w.revokedAt === undefined)
      .map((w) => w.registeredAt);
    // A client with no active entry for this address (defensive - the caller's query should never
    // hand one in) sorts last rather than throwing on Math.min of nothing.
    return times.length > 0 ? Math.min(...times) : Number.MAX_SAFE_INTEGER;
  };
  const sorted = [...clients].sort((a, b) => {
    const diff = earliestActiveRegistration(a) - earliestActiveRegistration(b);
    if (diff !== 0) return diff;
    return a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0;
  });
  return {client: sorted[0], multiMatch: clients.length > 1};
}

export interface MobileBookingClientResolution {
  client: ClientDoc;
  /** Review finding 6: true when the verified wallet matched MORE THAN ONE client record -
   * persisted to `bookingIdentity.walletMultiMatch` for staff visibility. Always false on the
   * email/phone/create path. */
  walletMultiMatch: boolean;
}

/**
 * WP4.4 Q1's client-resolution order: "verified wallet match against Client.wallets[] FIRST, else
 * today's email-then-phone clientMatch, else create." Only a VERIFIED wallet address is ever
 * matched on - an unverified claim is never passed in here at all (an invalid signature rejects
 * the whole booking per Q2, before client resolution ever runs). Excludes revoked wallet entries
 * from the match: a revoked wallet's key may have been revoked BECAUSE it was compromised, so
 * possession of a signature from it must not still resolve to the client that once owned it.
 *
 * Review finding 6: fetches EVERY matching client (not a nondeterministic `findOne`) and picks via
 * `pickDeterministicWalletClient`, reporting the multi-match fact alongside the resolved client so
 * the booking route can persist it for staff.
 */
export async function findOrCreateClientForMobileBooking(input: {
  verifiedWalletAddress?: string;
  client: {name: string; email: string; phone?: string};
}): Promise<MobileBookingClientResolution> {
  if (input.verifiedWalletAddress) {
    const walletMatches = await Client.find({
      wallets: {$elemMatch: {address: input.verifiedWalletAddress, revokedAt: {$exists: false}}},
    }).lean<ClientDoc[]>();
    const pick = pickDeterministicWalletClient(walletMatches, input.verifiedWalletAddress);
    if (pick) return {client: pick.client, walletMultiMatch: pick.multiMatch};
  }
  return {client: await findOrCreateClientForBooking(input.client), walletMultiMatch: false};
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
  // `runValidators: true` (review finding 8): update operations skip schema validation by mongoose
  // default - without it, the wallet subdocument's conditional registrationId/blockNumber
  // requirement (`models/Client.ts`) would only ever bind on document-level saves, which no wallet
  // append path uses. Same flag as `lib/registration/mongoStore.ts`'s appendWalletToClient.
  const updated = await Client.findOneAndUpdate(
    {clientId, "wallets.address": {$ne: entry.address}},
    {$push: {wallets: entry}},
    {new: true, runValidators: true},
  ).lean<ClientDoc>();
  return Boolean(updated);
}
