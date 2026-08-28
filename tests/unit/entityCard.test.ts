import {describe, expect, it} from "vitest";
import {buildEntityCard} from "@/lib/entityCard";
import type {ClinicSettingsDoc} from "@/lib/models/ClinicSettings";

function baseSettings(overrides: Partial<ClinicSettingsDoc["businessProfile"]> = {}): ClinicSettingsDoc {
  return {
    _id: "singleton",
    receivingAddresses: [],
    businessProfile: overrides,
    rpcOverrides: {},
    icsFeedToken: "abc123",
    updatedAt: new Date(),
  };
}

describe("buildEntityCard", () => {
  it("defaults coordinates to 0,0 and kind to VET when nothing is configured", () => {
    const card = buildEntityCard(baseSettings(), false);
    expect(card.kind).toBe("VET");
    expect(card.coordinates).toEqual({lat: 0, lng: 0});
    expect(card.bookingEnabled).toBe(false);
    expect(card.name).toBe("Vet clinic");
    expect(card.branding).toEqual({});
    expect(card.contact).toEqual({});
    expect(card.address).toEqual({});
  });

  it("omits blank branding/contact/address fields rather than sending empty strings", () => {
    const card = buildEntityCard(
      baseSettings({name: "Riverside Vet", logoUrl: "https://example.com/logo.png", contactEmail: "hi@example.com"}),
      true,
    );
    expect(card.name).toBe("Riverside Vet");
    expect(card.branding).toEqual({logoUrl: "https://example.com/logo.png"});
    expect(card.contact).toEqual({email: "hi@example.com"});
    expect(card.bookingEnabled).toBe(true);
  });

  it("passes through configured address and coordinates", () => {
    const card = buildEntityCard(
      baseSettings({
        address: {line1: "1 Main St", city: "Springfield", country: "US"},
        coordinates: {lat: 39.78, lng: -89.65},
      }),
      false,
    );
    expect(card.address).toEqual({line1: "1 Main St", city: "Springfield", country: "US"});
    expect(card.coordinates).toEqual({lat: 39.78, lng: -89.65});
  });

  it("always reports kind VET regardless of input, since this template is vet-only", () => {
    const card = buildEntityCard(baseSettings(), false);
    expect(card.kind).toBe("VET");
  });
});
