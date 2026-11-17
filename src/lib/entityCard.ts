import type {EntityKindId} from "@dogtag/standard";
import type {ClinicSettingsDoc} from "@/lib/models/ClinicSettings";

/** `vet-public-api.yaml`'s `EntityCard` schema, reproduced here as a plain type so this builder
 * stays independently testable without importing anything Next/Mongo-flavored. */
export interface EntityCard {
  name: string;
  /** The PRIMARY kind: `"VET"` when `kinds` includes it, otherwise the lowest set kind. One string,
   * unchanged in shape for every existing consumer. */
  kind: EntityKindId;
  /** WP4.21: every kind the clinic's entity holds in `EntityRegistry`, in bit order. Always contains
   * `kind` and is never empty: a registry that is not configured, an unregistered account or a
   * failed read all report `["VET"]`. A record only - it grants no right. */
  kinds: EntityKindId[];
  branding: {logoUrl?: string; primaryColor?: string};
  contact: {email?: string; phone?: string};
  address: {
    line1?: string;
    line2?: string;
    city?: string;
    region?: string;
    postalCode?: string;
    country?: string;
  };
  coordinates: {lat: number; lng: number};
  bookingEnabled: boolean;
}

/** The card's kinds when nothing better is known (no registry, unregistered, unreadable). This
 * template is a vet clinic, so that is the honest default. */
export const DEFAULT_ENTITY_KINDS: readonly EntityKindId[] = ["VET"];

/** `kind` (the primary) for a kinds list: `"VET"` when present, else the first (lowest bit) kind. */
export function primaryKindOf(kinds: readonly EntityKindId[]): EntityKindId {
  return kinds.includes("VET") ? "VET" : (kinds[0] ?? "VET");
}

/**
 * Pure builder for `GET /v1/entity` (`vet-public-api.yaml`). `kinds` is what the route read from
 * the registry for this clinic's own entity account (`lib/entityCardKinds.ts`); it falls back to
 * `["VET"]` when empty or omitted, so the card can never be produced without a kind. `kind` is
 * derived from it, never stored separately.
 *
 * `coordinates` is required by the schema even though nothing in this app forces an operator to
 * set real ones during setup; a not-yet-configured clinic reports `{lat: 0, lng: 0}` (0,0 in the
 * Gulf of Guinea) rather than omitting the field and breaking wire conformance. The Settings page
 * copy calls out that a real value should be entered before going live.
 */
export function buildEntityCard(
  settings: ClinicSettingsDoc,
  bookingEnabled: boolean,
  kinds: readonly EntityKindId[] = DEFAULT_ENTITY_KINDS,
): EntityCard {
  const cardKinds: EntityKindId[] = kinds.length > 0 ? [...kinds] : [...DEFAULT_ENTITY_KINDS];
  const profile = settings.businessProfile ?? {};
  return {
    name: profile.name?.trim() || "Vet clinic",
    kind: primaryKindOf(cardKinds),
    kinds: cardKinds,
    branding: {
      ...(profile.logoUrl ? {logoUrl: profile.logoUrl} : {}),
      ...(profile.primaryColor ? {primaryColor: profile.primaryColor} : {}),
    },
    contact: {
      ...(profile.contactEmail ? {email: profile.contactEmail} : {}),
      ...(profile.phone ? {phone: profile.phone} : {}),
    },
    address: {
      ...(profile.address?.line1 ? {line1: profile.address.line1} : {}),
      ...(profile.address?.line2 ? {line2: profile.address.line2} : {}),
      ...(profile.address?.city ? {city: profile.address.city} : {}),
      ...(profile.address?.region ? {region: profile.address.region} : {}),
      ...(profile.address?.postalCode ? {postalCode: profile.address.postalCode} : {}),
      ...(profile.address?.country ? {country: profile.address.country} : {}),
    },
    coordinates: {
      lat: profile.coordinates?.lat ?? 0,
      lng: profile.coordinates?.lng ?? 0,
    },
    bookingEnabled,
  };
}
