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

export interface BusinessProfile {
  name?: string;
  logoUrl?: string;
  /** Where public-booking notifications ("a client just booked/cancelled") are sent. Distinct
   * from `EMAIL_FROM` (the outgoing SMTP identity) - this is a destination, not a sender. */
  contactEmail?: string;
}

export interface RpcOverrides {
  roax?: string;
  ethereum?: string;
  base?: string;
  sepolia?: string;
  baseSepolia?: string;
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
  updatedAt: Date;
}

const receivingAddressSchema = new Schema<ReceivingAddress>(
  {
    chainKey: {type: String, enum: ["ethereum", "base", "sepolia", "baseSepolia"], required: true},
    address: {type: String, required: true},
  },
  {_id: false},
);

const clinicSettingsSchema = new Schema<ClinicSettingsDoc>(
  {
    _id: {type: String, required: true},
    entityAccount: String,
    cloneAddress: String,
    operatorWallet: String,
    receivingAddresses: {type: [receivingAddressSchema], default: []},
    businessProfile: {
      name: String,
      logoUrl: String,
      contactEmail: String,
    },
    rpcOverrides: {
      roax: String,
      ethereum: String,
      base: String,
      sepolia: String,
      baseSepolia: String,
    },
    icsFeedToken: {type: String, index: true, sparse: true, unique: true},
  },
  {timestamps: {createdAt: false, updatedAt: true}},
);

export const ClinicSettings =
  getOrCreateModel<ClinicSettingsDoc>("ClinicSettings", clinicSettingsSchema);

const CLINIC_SETTINGS_ID = "singleton";

export async function getClinicSettings(): Promise<ClinicSettingsDoc> {
  const existing = await ClinicSettings.findById(CLINIC_SETTINGS_ID).lean<ClinicSettingsDoc>();
  if (existing) {
    if (existing.icsFeedToken) return existing;
    // Backfill for a deployment created before the ics feed existed.
    return rotateIcsFeedToken();
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
