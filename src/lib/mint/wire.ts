import {canonicalDecimal} from "@dogtag/standard";
import type {WeightEntry} from "@/lib/models/Pet";
import type {MintErrorStage, MintSessionStatus} from "@/lib/models/MintSession";

/** Pounds-to-kilograms, applied only at the wire boundary: `vet-public-api.yaml`'s `WeightEntry`
 * is always `weightKg` (a canonical decimal string), while this repo's own `Pet.weightHistory`
 * keeps the vet's original recording unit (`kg` or `lb`) so staff never see a value silently
 * converted on their own screen. `/p/:token` is the one place the two must agree. */
const LB_TO_KG = 0.45359237;

export function toWireWeightEntry(entry: WeightEntry): {recordedAt: string; weightKg: string} {
  const kgValue = entry.unit === "kg" ? entry.value : (Number(entry.value) * LB_TO_KG).toFixed(3);
  return {recordedAt: entry.measuredOn, weightKg: canonicalDecimal(kgValue)};
}

/**
 * `MintSessionStatusResponse.reason` MUST be a device-safe sentence derived from `errorStage`
 * only (wp4-vet.md issuance step 6, normative) - never the session row, never operator-facing
 * error text (which can carry internal detail: an RPC error message, a Mongo error, a wallet
 * rejection reason). This is the single place that translation happens, so no route can
 * accidentally leak `errorReason` to a mobile client.
 */
const DEVICE_SAFE_REASON: Record<MintErrorStage, string> = {
  attestation: "The submitted profile could not be verified. Ask the clinic to start a new tag.",
  seal: "This tag could not be sealed. Ask the clinic to try again.",
  issue: "Issuing this tag on chain did not complete. Ask the clinic to try again.",
  verify: "This tag's on-chain confirmation could not be verified. Ask the clinic to try again.",
  interrupted: "Issuance was interrupted. Ask the clinic to try again.",
};

export function deviceSafeReason(errorStage: MintErrorStage | undefined): string | undefined {
  if (!errorStage) return undefined;
  return DEVICE_SAFE_REASON[errorStage];
}

/** Every `status` enum in `vet-public-api.yaml`'s mint schemas is byte-identical to
 * `MintSessionDoc.status` - this exists only so call sites read as "wire status", not as a
 * coincidence nobody documented. */
export type WireMintStatus = MintSessionStatus;
export function toWireMintStatus(status: MintSessionStatus): WireMintStatus {
  return status;
}
