import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";
import {randomUUID} from "node:crypto";
import type {ReceiptRecord} from "@/lib/registration/receipt";

/**
 * One registered wallet - plans/wp4.2-client-wallet-registration.md, dogtag-vet section 1: "address
 * unique per client (same wallet MAY appear on different clients)". `receipt`/`receiptHash` are
 * the self-authenticating, offline-re-verifiable proof (docs/client-wallet-registration.md);
 * `revokedAt` is a bookkeeping flag only - a revoked entry is never deleted, so the receipt stays
 * available forever regardless of revocation.
 */
export interface ClientWallet {
  address: string; // lowercase 0x hex, unique within this client's wallets[]
  label?: string;
  /**
   * WP4.4 Q1: BOTH attach paths are legitimate and BOTH are wallet-signed - the WP4.2 QR ceremony
   * (`"registration"`, the default for any entry that predates this field) serves walk-ins; a
   * valid `MobileBooking` signature on an app booking (`"booking"`) auto-attaches the wallet here
   * too, just flagged for its different provenance. Absent means `"registration"` - every entry
   * written before this field existed came from that flow, and it remains the only flow that
   * writes here without setting it explicitly.
   */
  via?: "registration" | "booking";
  registrationId?: string; // the session's UUID v4 - only for via:"registration"
  /** Only for `via: "booking"` - the appointmentId whose signed claim attached this wallet. */
  bookingId?: string;
  receipt: ReceiptRecord;
  receiptHash: string;
  issuedAt: number; // unix seconds, denormalized from receipt.payloadJson's message for display
  /** Denormalized from receipt.payloadJson's message for display - only for `via: "registration"`.
   * `MobileBooking`'s signed struct carries no block number (section 2's struct fields), so a
   * `via: "booking"` entry has none to denormalize. */
  blockNumber?: number;
  registeredAt: number; // unix seconds this wallet was appended (server "now" at /w/:token/complete)
  revokedAt?: number; // unix seconds; undefined = active
}

export type ClientIdDocType = "passport" | "national_id" | "drivers_license" | "other";

export interface ClientDoc {
  clientId: string;
  name: string;
  email?: string;
  phone?: string;
  address?: string;
  notes?: string;
  /** WP4.3 A2: optional identification-document fields - only `name` stays required on a client.
   * Both are deliberately excluded from two places that otherwise touch every other client field:
   * `buildClientSearchKey` below (no ID numbers in a substring-searchable index), and WP4.2's
   * `clientHash` canonicalization (`src/lib/registration/clientHash.ts`'s `ClientHashFields` -
   * already-signed wallet-registration receipts must stay verifiable against the exact
   * {name,email,phone,address} shape they were signed over, which must never grow a new field). */
  idDocType?: ClientIdDocType;
  idDocNumber?: string;
  petIds: string[];
  wallets: ClientWallet[];
  searchKey: string;
  createdAt: Date;
  updatedAt: Date;
}

const clientWalletReceiptSchema = new Schema<ReceiptRecord>(
  {
    payloadJson: {type: String, required: true},
    signature: {type: String, required: true},
    recoveredAt: {type: Number, required: true},
  },
  {_id: false},
);

/** Review finding 8 - see `registrationId`/`blockNumber` in the schema below. Mongoose binds
 * `this` to the subdocument being validated, both on a full document save and on the element of a
 * `$push` when the update runs with `runValidators: true` (both wallet-append call sites do -
 * `lib/registration/mongoStore.ts` and `lib/booking/clientMatch.ts`). `via` absent means the
 * WP4.2 registration flow (the only writer that predates the field), so absence requires them
 * exactly like an explicit `"registration"` does. */
function requiredUnlessBookingSourced(this: ClientWallet): boolean {
  return this.via !== "booking";
}

const clientWalletSchema = new Schema<ClientWallet>(
  {
    address: {type: String, required: true},
    label: String,
    via: {type: String, enum: ["registration", "booking"]},
    // Review finding 8: WP4.4 widened these two to plain-optional for ALL entries so a
    // via:"booking" entry (whose MobileBooking struct carries neither field) could be stored - but
    // that silently dropped the invariant every registration-sourced entry had always carried, the
    // one WalletsPanel's RegistrationSourcedWallet narrowing and scripts/verify-receipt.ts's
    // export contract depend on. Conditionally required restores it: mandatory unless the entry is
    // booking-sourced.
    registrationId: {
      type: String,
      required: [requiredUnlessBookingSourced, "registrationId is required for a registration-sourced wallet"],
    },
    bookingId: String,
    receipt: {type: clientWalletReceiptSchema, required: true},
    receiptHash: {type: String, required: true},
    issuedAt: {type: Number, required: true},
    blockNumber: {
      type: Number,
      required: [requiredUnlessBookingSourced, "blockNumber is required for a registration-sourced wallet"],
    },
    registeredAt: {type: Number, required: true},
    revokedAt: Number,
  },
  {_id: false},
);

const clientSchema = new Schema<ClientDoc>(
  {
    clientId: {type: String, required: true, unique: true, default: () => randomUUID()},
    name: {type: String, required: true, trim: true},
    email: {type: String, trim: true, lowercase: true},
    phone: {type: String, trim: true},
    address: {type: String, trim: true},
    notes: {type: String},
    idDocType: {type: String, enum: ["passport", "national_id", "drivers_license", "other"]},
    idDocNumber: {type: String, trim: true},
    petIds: {type: [String], default: []},
    wallets: {type: [clientWalletSchema], default: []},
    searchKey: {type: String, required: true, index: true},
  },
  {timestamps: true},
);

clientSchema.index({searchKey: "text"});

export const Client = getOrCreateModel<ClientDoc>("Client", clientSchema);

/**
 * The write-verification tripwire for EVERY wallet-append call site (WP4.5 track3-sig fix 2 -
 * `lib/registration/mongoStore.ts`'s `appendWalletToClient` AND `lib/booking/clientMatch.ts`'s
 * `appendBookingWalletToClient`, the only two places that ever `$push` onto `wallets[]`).
 *
 * Forensic incident this exists for: a `findOneAndUpdate({..., "wallets.address": {$ne: address}},
 * {$push: {wallets: entry}}, {new: true})` call MATCHING and returning a document is not proof the
 * push actually happened - a long-lived process serving a `Client` model registered before
 * `wallets[]` existed silently strips the `$push` under mongoose's default strict mode (the path
 * casting has no idea what `wallets` is), while the query still matches and returns the document
 * completely unchanged. The caller's `findOneAndUpdate` call sees a truthy result either way, so
 * without this check it reports success - a false "ok" the client believed it had earned
 * (`tests/unit/registration/staleModelRepro.integration.test.ts` reproduces the exact mechanism
 * against a real mongod). `src/lib/models/registerModel.ts`'s schema-fingerprint fix closes off the
 * ROOT CAUSE of a stale model surviving at all; this is the independent, defense-in-depth backstop
 * for the one write that root cause could otherwise corrupt silently - callers must never persist a
 * "the wallet is attached" outcome without this check passing first.
 */
export function assertWalletActuallyPushed(
  updated: {wallets?: Pick<ClientWallet, "address">[]} | null,
  clientId: string,
  address: string,
): void {
  const lowerAddress = address.toLowerCase();
  const pushed = (updated?.wallets ?? []).some((w) => w.address.toLowerCase() === lowerAddress);
  if (!pushed) {
    throw new Error(
      `appendWalletToClient: findOneAndUpdate matched client ${clientId} but the returned document does not ` +
        `contain wallet ${address} in wallets[] - likely a stale cached Mongoose Client model missing the ` +
        `wallets path (restart the server process). Refusing to report this wallet as attached.`,
    );
  }
}

/** Lowercased, whitespace-collapsed name+email+phone blob used for the search box - kept
 * denormalized on the document so listing/search queries never need a runtime join or regex
 * across multiple fields.
 *
 * Deliberately never reads `idDocType`/`idDocNumber` (WP4.3 A2, normative): an identification
 * document number must never end up in a substring-searchable index. This is enforced structurally
 * by the parameter type below picking only {name, email, phone} - a caller may still pass a wider
 * object (e.g. a full `ClientDoc`) through it, but this function only ever reads these three
 * fields off it. */
export function buildClientSearchKey(fields: Pick<ClientDoc, "name" | "email" | "phone">): string {
  return [fields.name, fields.email, fields.phone]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Round-2 fix: splits an already-parsed PATCH payload into Mongo `$set`/`$unset` operations, ruled
 * on the null-ness of each value alone - a `null` value becomes an `$unset` (explicit clear), any
 * other defined value becomes a `$set`, and a key that is `undefined` (or simply absent, since
 * `Object.entries` never sees an absent key at all) is left out of both, leaving that field
 * untouched. Not specific to any one field by design, so it composes correctly for whichever subset
 * of a payload's fields happen to be nullable per their zod schema (today: only
 * `updateClientSchema`'s `idDocType`/`idDocNumber` - see its doc comment for why the rest of the
 * optional client fields are not, yet).
 *
 * The route still owns applying these (`Client.findOneAndUpdate({...}, {$set, $unset})`) and
 * computing `searchKey` from the resulting merged shape - this only decides which bucket each field
 * goes in.
 */
export function splitSetUnsetOps(fields: Record<string, unknown>): {setOps: Record<string, unknown>; unsetOps: Record<string, "">} {
  const setOps: Record<string, unknown> = {};
  const unsetOps: Record<string, ""> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) unsetOps[key] = "";
    else if (value !== undefined) setOps[key] = value;
  }
  return {setOps, unsetOps};
}
