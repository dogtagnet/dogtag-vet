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
  failed: "Signature didn't match",
  expired: "Expired",
};
