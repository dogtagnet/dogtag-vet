import type {ClinicSettingsDoc} from "@/lib/models/ClinicSettings";

/** `vet-public-api.yaml`'s `EntityCard` schema, reproduced here as a plain type so this builder
 * stays independently testable without importing anything Next/Mongo-flavored. */
export interface EntityCard {
  name: string;
  kind: "VET" | "GOVERNMENT" | "GROOMER";
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

/**
 * Pure builder for `GET /v1/entity` (`vet-public-api.yaml`). This deployment template is always a
 * vet clinic, so `kind` is fixed to `"VET"` - there is no vet/government/groomer toggle anywhere
 * in this app's data model, and inventing one to populate a field this template never varies
 * would be worse than just being honest about what it always is.
 *
 * `coordinates` is required by the schema even though nothing in this app forces an operator to
 * set real ones during setup; a not-yet-configured clinic reports `{lat: 0, lng: 0}` (0,0 in the
 * Gulf of Guinea) rather than omitting the field and breaking wire conformance. The Settings page
 * copy calls out that a real value should be entered before going live.
 */
export function buildEntityCard(settings: ClinicSettingsDoc, bookingEnabled: boolean): EntityCard {
  const profile = settings.businessProfile ?? {};
  return {
    name: profile.name?.trim() || "Vet clinic",
    kind: "VET",
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
