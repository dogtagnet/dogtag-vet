import type {RegistrationStatus} from "@/lib/registration/flow";
import type {StatusTone} from "@/components/ui/StatusBadge";

/**
 * Single source of truth mapping a wallet-registration session's live status onto the shared
 * status-tone palette (design-system.md), matching `tagStatusTone.ts`'s
 * `mintSessionStatusTone`/`mintSessionStatusLabel` convention for the Wallets panel's own
 * in-flight QR state.
 */
export const registrationStatusTone: Record<RegistrationStatus, StatusTone> = {
  waiting: "neutral",
  registered: "ok",
  failed: "danger",
  expired: "danger",
};

export const registrationStatusLabel: Record<RegistrationStatus, string> = {
  waiting: "Waiting for scan...",
  registered: "Registered",
  // Only a FALLBACK for a `failed` status with no confirmed outcome (see `registrationFailedLabel`
  // below, which every real caller uses instead) - kept honest by default rather than the
  // "Signature didn't match" accusation this key used to carry unconditionally.
  failed: "Registration failed",
  expired: "Expired",
};

/**
 * WP4.5 track3-sig fix 3: `status: "failed"` alone does not tell the panel WHY - the forensic
 * incident was a `failed` registration where the signature was perfectly valid and a server-side
 * write silently never landed, and the panel's old unconditional "Signature didn't match" copy
 * accused the wrong party. `outcome` (from the status poll's `GetRegistrationStatusResult`, itself
 * `RegistrationSessionRow.outcome` - see that field's own doc comment) says whether this specific
 * `failed` was actually confirmed as a bad signature; every other case (including an old session
 * with no recorded outcome at all) gets a neutral, non-accusatory message instead.
 */
export function registrationFailedLabel(outcome?: "registered" | "signature_invalid"): string {
  return outcome === "signature_invalid" ? "Signature didn't match" : "Registration could not be completed";
}

export function registrationFailedMessage(outcome?: "registered" | "signature_invalid"): string {
  return outcome === "signature_invalid"
    ? "The signature did not match this wallet. This code cannot be reused - generate a new one."
    : "This registration did not complete due to a server-side issue, not a bad signature. This code cannot be reused - generate a new one.";
}
