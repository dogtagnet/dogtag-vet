import type {DogTagStatus} from "@/lib/models/Pet";
import type {MintSessionStatus} from "@/lib/models/MintSession";
import type {StatusTone} from "@/components/ui/StatusBadge";

/**
 * Single source of truth mapping `Pet.dogTag.status` onto the shared status-tone palette
 * (design-system.md), matching `appointmentTone.ts`/`paymentTone.ts`'s pattern - used everywhere a
 * durable, already-anchored tag's status renders (`/tags`, `/pets`, the pet detail `PetTagCard`),
 * so it never drifts between call sites the way the raw `label={status}` it replaces did.
 */
export const dogTagStatusTone: Record<DogTagStatus, StatusTone> = {
  active: "ok",
  revoked: "danger",
};

export const dogTagStatusLabel: Record<DogTagStatus, string> = {
  active: "Active",
  revoked: "Revoked",
};

/**
 * Single source of truth for an in-flight `MintSession`'s status - the tag's status BEFORE it
 * becomes a durable `Pet.dogTag` record. Shared by `/tags`' "in progress" table and the
 * `/tags/issue` wizard's own status badge, which previously each carried their own, slightly
 * different, ad hoc tone logic for the same five values.
 */
export const mintSessionStatusTone: Record<MintSessionStatus, StatusTone> = {
  pending: "neutral",
  ready: "info",
  issuing: "info",
  bound: "ok",
  error: "danger",
};

export const mintSessionStatusLabel: Record<MintSessionStatus, string> = {
  pending: "Pending",
  ready: "Ready",
  issuing: "Issuing",
  bound: "Bound",
  error: "Error",
};
