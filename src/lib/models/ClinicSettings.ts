import {Schema} from "mongoose";
import {randomBytes} from "node:crypto";
import {getOrCreateModel} from "@/lib/models/registerModel";
import type {PaymentChainKey} from "@/lib/chains";

/**
 * Singleton clinic-wide configuration persisted by the setup wizard and settings pages
 * (wp4-vet.md's Onboarding section). Not part of the spec's named Data model list, but implied by
 * it: the wizard has nowhere else to persist the entity account, discovered clone, per-chain
 * receiving addresses, business profile card, and RPC overrides it collects. Always exactly one
 * document; use getClinicSettings()/updateClinicSettings() rather than a raw find/save.
 */
export interface ReceivingAddress {
  chainKey: PaymentChainKey;
  address: string;
}

export interface BusinessAddress {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  /** ISO 3166-1 alpha-2, per `specs/vet-public-api.yaml`'s `EntityCard.address.country`. */
  country?: string;
}

export interface BusinessCoordinates {
  lat: number;
  lng: number;
}

export interface BusinessProfile {
  name?: string;
  logoUrl?: string;
  /** Where public-booking notifications ("a client just booked/cancelled") are sent. Distinct
   * from `EMAIL_FROM` (the outgoing SMTP identity) - this is a destination, not a sender. */
  contactEmail?: string;
  /**
   * This clinic's stable DNS-domain issuer identity - `protocol/specs/issuer-attestation.md`'s
   * `issuerDomain` message field and `dogtag-standard-ts`'s `IssuerMeta.domain`. A `did:web`-style
   * IDENTITY, not a contact address: it need not resolve or serve anything (a verifier's offline
   * DNS-TXT identity check reads it, but that is the only consumer). Deliberately distinct from
   * `contactEmail` (an inbox, not a domain, and semantically the wrong value for a field a
   * verifier resolves as DNS) - see the C3 attestation route's own doc comment for why signing an
   * email address here was a bug, not a placeholder choice. */
  domain?: string;
  /** Public contact phone, shown on the entity card (`GET /v1/entity`'s `contact.phone`). */
  phone?: string;
  /** Accent color for the entity card's `branding.primaryColor` - a design token this deployment
   * chooses for its own public-facing card, not one of this app's own UI tokens. */
  primaryColor?: string;
  address?: BusinessAddress;
  /** Required by `EntityCard.coordinates`; unset until the operator supplies real coordinates in
   * Settings, at which point `GET /v1/entity` starts reporting them instead of the 0,0 default -
   * see `src/lib/entityCard.ts`. */
  coordinates?: BusinessCoordinates;
}

export interface RpcOverrides {
  /** Overrides `ROAX_RPC_URL` for BOTH the identity-chain reads (`src/lib/chainRead.ts` - not
   * actually wired there yet, a pre-existing gap disclosed in `paymentChainRead.ts`'s
   * `roaxChainId()` doc comment) and, as of WP4.18, the payment-chain reads
   * (`src/lib/paymentChainRead.ts`'s `paymentPublicClient`, which DOES honor this field, checked
   * fresh on every call). One field, since ROAX is the only chain this app talks to at all. */
  roax?: string;
}

export interface ClinicSettingsDoc {
  _id: string; // always the fixed singleton id - see CLINIC_SETTINGS_ID below
  entityAccount?: string; // the entity's account address in EntityRegistry
  cloneAddress?: string; // this clinic's VetIssuer clone, discovered via VetIssuerFactory.cloneOf
  operatorWallet?: string; // last-connected wallet address, for display continuity across visits
  receivingAddresses: ReceivingAddress[];
  businessProfile: BusinessProfile;
  rpcOverrides: RpcOverrides;
  /** Bearer token in the path of the read-only ics feed (`/api/calendar/feed/:token`, v1
   * pattern) - rotatable from Settings so a leaked link can be invalidated without touching
   * anything else. Generated lazily on first read (`getClinicSettings`) rather than at schema
   * level so every pre-existing deployment gets one transparently. */
  icsFeedToken: string;
  /** The chain-activity follower's cursor (`src/worker/index.ts`) - the next block to scan from.
   * Lives here rather than a dedicated collection since this deployment only ever follows one
   * clone, so there is exactly one cursor to keep, same singleton as everything else here. */
  activityCursorBlock?: number;
  /**
   * WP4.15 multi-owner (PLANNED) - opts this clinic's `/verify` consent-relayer flow into
   * targeting its OWN clone as the on-chain relayer (`VetIssuer.relayVerification`, `docs/
   * DELEGATION.md` section 7's "relayVerification is a new relayer") instead of the connected
   * staff wallet submitting `recordVerificationZK` directly. Off by default, and pending a real
   * whitelisting step this app cannot perform itself: the protocol admin must separately grant
   * `EntityRegistry.canVerify(purpose, thisClinicsClone)` before ANY session started with this
   * flag on can actually confirm on chain - `POST /api/verify/start`'s existing `readCanVerify`
   * preflight (unmodified) already fails closed with a clear message if that grant is missing, the
   * exact same way it already does for an unwhitelisted staff wallet today - so turning this flag
   * on before the admin grant exists is honestly refused, never a silent revert (the WP4.16
   * OperatorsSection lesson: never ship a control whose write always fails on a real chain).
   */
  consentRelayerViaCloneEnabled?: boolean;
  updatedAt: Date;
}

const receivingAddressSchema = new Schema<ReceivingAddress>(
  {
    chainKey: {type: String, enum: ["roax"], required: true},
    address: {type: String, required: true},
  },
  {_id: false},
);

/**
 * Its own `Schema` (rather than a plain nested-object literal, `receivingAddressSchema`'s own
 * convention) for two reasons together: it lets `default: () => ({})` attach unambiguously - see
 * the `businessProfile` field below for why that default has to exist - and `{_id: false}` keeps
 * Mongoose from giving this single-nested subdocument its own generated `_id`, which every OTHER
 * embedded object here (`rpcOverrides`, wrapped in its own equivalent `Schema` below for exactly
 * the same reason, since WP4.18 found it needed the identical default treatment) does not carry
 * either. Verified live against a real MongoDB: without `{_id: false}` an unrelated field on the
 * SAME nested-object-literal syntax comes back with a stray `_id` that has no business being there
 * and no field in the `BusinessProfile` interface to hold it.
 */
const businessProfileSchema = new Schema<BusinessProfile>(
  {
    name: String,
    logoUrl: String,
    contactEmail: String,
    domain: String,
    phone: String,
    primaryColor: String,
    address: {
      line1: String,
      line2: String,
      city: String,
      region: String,
      postalCode: String,
      country: String,
    },
    coordinates: {
      lat: Number,
      lng: Number,
    },
  },
  // `minimize: false` is load-bearing, not decorative: Mongoose's default (`minimize: true`)
  // strips a subdocument down to nothing - both from `.toObject()`/`.lean()` output AND from what
  // actually gets written to MongoDB on save - the instant every one of its fields is blank,
  // which an untouched `businessProfile: {}` always is on a fresh deployment. Verified live: with
  // `minimize` left at its default, the schema-level `default: () => ({})` below produces `{}` on
  // the in-memory document immediately after `create()`, but `doc.toObject()` and the persisted
  // Mongo document both come back with the `businessProfile` key ABSENT - the exact bug this
  // whole file exists to fix, just relocated one layer down. `{_id: false}` (see above) keeps this
  // now-always-present subdocument from also carrying an unwanted generated `_id`.
  {_id: false, minimize: false},
);

/**
 * WP4.18 - `paymentChainRead.ts`'s `paymentPublicClient(chainKey, rpcOverrides)` unconditionally
 * dereferences `rpcOverrides[chainKey]`, so this needs the exact same `Schema` + `default: () =>
 * ({})` treatment `businessProfileSchema` above already documents (a plain nested-object literal,
 * this field's own shape before this wave, has no materialized value until a leaf field is set,
 * so a fresh singleton reads it back as `undefined`, not `{}`) - without it, the payment watcher's
 * every scan on a brand-new, never-configured deployment throws `Cannot read properties of
 * undefined (reading 'roax')`, forever, until an operator happens to save the Settings page once.
 * Caught live by this wave's own new e2e coverage (roax-payment.spec.ts), the first thing to ever
 * run the payment watcher against a freshly-created clinic - a pre-existing bug (the four
 * now-removed chains' rpcOverrides fields had the identical gap), not something WP4.18 introduced.
 */
// `minimize: false` here AND on `clinicSettingsSchema` itself (below) - both are load-bearing,
// confirmed by direct experiment: this subdocument's own opt-out is not sufficient on its own,
// since Mongoose's default `minimize: true` strips an all-EMPTY nested object (zero keys - exactly
// what an untouched `rpcOverrides: {}` always is) back out of the PARENT's `.toObject()`/`.lean()`
// output regardless of what the child schema says, unless the parent ALSO opts out.
const rpcOverridesSchema = new Schema<RpcOverrides>({roax: String}, {_id: false, minimize: false});

const clinicSettingsSchema = new Schema<ClinicSettingsDoc>(
  {
    _id: {type: String, required: true},
    entityAccount: String,
    cloneAddress: String,
    operatorWallet: String,
    receivingAddresses: {type: [receivingAddressSchema], default: []},
    // Every reader (invoice PDF generation chief among them - see pdf.ts) dereferences fields off
    // this object unconditionally, on the assumption it exists even when every field inside it is
    // still blank. A nested subdocument path like this one has no materialized value in MongoDB
    // until a leaf field is set, so WITHOUT an explicit default a fresh, never-configured
    // deployment reads this back as `undefined` (not `{}`) and every PDF path throws.
    // `default: () => ({})` makes Mongoose persist an empty object at document-creation time
    // instead of leaving the path absent. `getClinicSettings()` below additionally backfills this
    // for deployments whose singleton document predates this default.
    businessProfile: {type: businessProfileSchema, default: () => ({})},
    // `default: () => ({})` for the exact reason `businessProfile`'s own comment above states -
    // WITHOUT it, a fresh, never-configured singleton reads this field back as `undefined`, not
    // `{}`, and `paymentPublicClient(chainKey, rpcOverrides)` (`src/lib/paymentChainRead.ts`)
    // unconditionally dereferences `rpcOverrides[chainKey]`, so every payment-watcher scan on a
    // brand-new deployment throws `Cannot read properties of undefined (reading 'roax')` on every
    // tick, forever, until an operator happens to save the Settings page once (WP4.18's own new
    // e2e coverage caught this live - the first thing to ever run the payment watcher against a
    // freshly-created clinic). `getClinicSettings()` below backfills it for documents that predate
    // this default, same pattern as `businessProfile`/`icsFeedToken`.
    rpcOverrides: {type: rpcOverridesSchema, default: () => ({})},
    icsFeedToken: {type: String, index: true, sparse: true, unique: true},
    activityCursorBlock: Number,
    consentRelayerViaCloneEnabled: Boolean,
  },
  // `minimize: false` at THIS (outer) level too - confirmed by direct experiment, not assumed: a
  // nested schema's OWN `{minimize: false}` (rpcOverridesSchema's) is not sufficient by itself.
  // Mongoose's serialization strips an all-empty nested object (zero keys - exactly what an
  // untouched `rpcOverrides: {}` always is) back out of the PARENT's `.toObject()`/`.lean()`
  // output unless the PARENT schema also opts out of minimizing. `businessProfile` never needed
  // this because its own nested plain-object fields (`address`/`coordinates`) always leave it with
  // at least one key, so it never looked "empty" to the parent in the first place.
  {timestamps: {createdAt: false, updatedAt: true}, minimize: false},
);

export const ClinicSettings =
  getOrCreateModel<ClinicSettingsDoc>("ClinicSettings", clinicSettingsSchema);

const CLINIC_SETTINGS_ID = "singleton";

export async function getClinicSettings(): Promise<ClinicSettingsDoc> {
  const existing = await ClinicSettings.findById(CLINIC_SETTINGS_ID).lean<ClinicSettingsDoc>();
  if (existing) {
    const backfill: Partial<ClinicSettingsDoc> = {};
    // Deployments whose singleton document predates a given default (the ics feed token
    // originally, businessProfile's `default: () => ({})` more recently) never get that default
    // applied retroactively by Mongoose - defaults only fire at document-creation time - so every
    // such pre-existing deployment reads the field back as missing/undefined forever unless
    // patched here once, on first read after the upgrade.
    if (!existing.icsFeedToken) backfill.icsFeedToken = randomBytes(16).toString("hex");
    if (!existing.businessProfile) backfill.businessProfile = {};
    if (!existing.rpcOverrides) backfill.rpcOverrides = {};
    if (Object.keys(backfill).length === 0) return existing;
    return updateClinicSettings(backfill);
  }
  const created = await ClinicSettings.create({_id: CLINIC_SETTINGS_ID, icsFeedToken: randomBytes(16).toString("hex")});
  return created.toObject();
}

/** Issues a fresh ics-feed token, invalidating every previously-issued feed URL. */
export async function rotateIcsFeedToken(): Promise<ClinicSettingsDoc> {
  const updated = await ClinicSettings.findByIdAndUpdate(
    CLINIC_SETTINGS_ID,
    {$set: {icsFeedToken: randomBytes(16).toString("hex")}},
    {upsert: true, new: true},
  ).lean<ClinicSettingsDoc>();
  if (!updated) throw new Error("Failed to rotate ics feed token");
  return updated;
}

export async function updateClinicSettings(
  patch: Partial<Omit<ClinicSettingsDoc, "updatedAt">>,
): Promise<ClinicSettingsDoc> {
  const updated = await ClinicSettings.findByIdAndUpdate(
    CLINIC_SETTINGS_ID,
    {$set: patch},
    {upsert: true, new: true},
  ).lean<ClinicSettingsDoc>();
  if (!updated) throw new Error("Failed to persist clinic settings");
  return updated;
}
