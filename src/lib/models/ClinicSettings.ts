import {Schema} from "mongoose";
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
}

export interface RpcOverrides {
  roax?: string;
  ethereum?: string;
  base?: string;
  sepolia?: string;
  baseSepolia?: string;
}

export interface ClinicSettingsDoc {
  entityAccount?: string; // the entity's account address in EntityRegistry
  cloneAddress?: string; // this clinic's VetIssuer clone, discovered via VetIssuerFactory.cloneOf
  operatorWallet?: string; // last-connected wallet address, for display continuity across visits
  receivingAddresses: ReceivingAddress[];
  businessProfile: BusinessProfile;
  rpcOverrides: RpcOverrides;
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
    entityAccount: String,
    cloneAddress: String,
    operatorWallet: String,
    receivingAddresses: {type: [receivingAddressSchema], default: []},
    businessProfile: {
      name: String,
      logoUrl: String,
    },
    rpcOverrides: {
      roax: String,
      ethereum: String,
      base: String,
      sepolia: String,
      baseSepolia: String,
    },
  },
  {timestamps: {createdAt: false, updatedAt: true}},
);

export const ClinicSettings =
  getOrCreateModel<ClinicSettingsDoc>("ClinicSettings", clinicSettingsSchema);

const CLINIC_SETTINGS_ID = "singleton";

export async function getClinicSettings(): Promise<ClinicSettingsDoc> {
  const existing = await ClinicSettings.findById(CLINIC_SETTINGS_ID).lean<ClinicSettingsDoc>();
  if (existing) return existing;
  const created = await ClinicSettings.create({_id: CLINIC_SETTINGS_ID});
  return created.toObject();
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
