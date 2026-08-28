import type {VerifySessionStatus} from "@/lib/models/VerifySession";
import type {StatusTone} from "@/components/ui/StatusBadge";

/** Single source of truth mapping a `/verify` relayer session's status onto the shared
 * status-tone palette, matching `appointmentTone.ts`/`paymentTone.ts`'s pattern. The panel's
 * previous inline logic only ever distinguished "recorded" (ok) from everything else (info) -
 * which rendered a failed session's "error" status in the same blue as an in-progress one. */
export const verifySessionStatusTone: Record<VerifySessionStatus, StatusTone> = {
  pending: "neutral",
  proof_received: "info",
  submitting: "info",
  recorded: "ok",
  error: "danger",
};

export const verifySessionStatusLabel: Record<VerifySessionStatus, string> = {
  pending: "Pending",
  proof_received: "Proof received",
  submitting: "Submitting",
  recorded: "Recorded",
  error: "Error",
};
