import type {PaymentStatus} from "@/lib/models/Payment";
import type {StatusTone} from "@/components/ui/StatusBadge";

/** Single source of truth mapping payment statuses onto the shared status-tone palette
 * (design-system.md: "Paid" -> ok, "Pending" -> warn, "Cancelled" -> danger, "Expired" -> neutral -
 * each an explicit example in the palette's own doc comment). */
export const paymentStatusTone: Record<PaymentStatus, StatusTone> = {
  pending: "warn",
  paid: "ok",
  cancelled: "danger",
  expired: "neutral",
};

export const paymentStatusLabel: Record<PaymentStatus, string> = {
  pending: "Pending",
  paid: "Paid",
  cancelled: "Cancelled",
  expired: "Expired",
};

export const paymentStatuses: PaymentStatus[] = ["pending", "paid", "cancelled", "expired"];
