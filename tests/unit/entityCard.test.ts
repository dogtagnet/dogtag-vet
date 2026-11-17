import {describe, expect, it} from "vitest";
import {buildEntityCard} from "@/lib/entityCard";
import {resolveEntityCardKinds} from "@/lib/entityCardKinds";
import type {EntityKindsRead} from "@/lib/chainRead";
import {validateAgainstVetSpec} from "./helpers/vetSpec";
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

  it("defaults to kinds [VET] and kind VET when no kinds are passed", () => {
    const card = buildEntityCard(baseSettings(), false);
    expect(card.kind).toBe("VET");
    expect(card.kinds).toEqual(["VET"]);
  });

  it("an empty kinds list falls back to [VET]", () => {
    const card = buildEntityCard(baseSettings(), false, []);
    expect(card.kinds).toEqual(["VET"]);
    expect(card.kind).toBe("VET");
  });

  it("kind stays VET when the kinds include VET, whatever the order", () => {
    const card = buildEntityCard(baseSettings(), false, ["VET", "GROOMER"]);
    expect(card.kind).toBe("VET");
    expect(card.kinds).toEqual(["VET", "GROOMER"]);
  });

  it("kind is the primary (first) kind when VET is not among them", () => {
    expect(buildEntityCard(baseSettings(), false, ["GROOMER", "BOARDING"]).kind).toBe("GROOMER");
    expect(buildEntityCard(baseSettings(), false, ["GOVERNMENT"]).kind).toBe("GOVERNMENT");
  });

  it("validates against the vendored vet-public-api.yaml EntityCard schema", () => {
    for (const kinds of [undefined, ["VET"], ["VET", "GROOMER"], ["DAYCARE", "BOARDING"]] as const) {
      const card = buildEntityCard(baseSettings({name: "Riverside Vet", contactEmail: "hi@example.com"}), true, kinds);
      const {valid, errors} = validateAgainstVetSpec("EntityCard", card);
      expect(errors).toBe("");
      expect(valid).toBe(true);
    }
  });

  it("the spec validator is not vacuous: a card without kinds is rejected", () => {
    const withoutKinds: Record<string, unknown> = {...buildEntityCard(baseSettings(), false)};
    delete withoutKinds.kinds;
    expect(validateAgainstVetSpec("EntityCard", withoutKinds).valid).toBe(false);
  });
});

describe("resolveEntityCardKinds (route-side registry read)", () => {
  const REGISTRY = "0x00000000000000000000000000000000000e9157";
  const ACCOUNT = "0x0000000000000000000000000000000000000acc";
  const reader = (answer: EntityKindsRead | Error) => async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  };

  it("version 2 path: a multi-kind mask becomes kinds in bit order, and the card keeps kind VET", async () => {
    const kinds = await resolveEntityCardKinds({entityAccount: ACCOUNT}, {registryAddress: REGISTRY, read: reader({status: "registered", mask: 10n})});
    expect(kinds).toEqual(["VET", "GROOMER"]);
    expect(buildEntityCard(baseSettings(), true, kinds).kind).toBe("VET");
  });

  it("version 1 path: a legacy single-kind mask (Government = 4) reports GOVERNMENT as the primary kind", async () => {
    const kinds = await resolveEntityCardKinds({entityAccount: ACCOUNT}, {registryAddress: REGISTRY, read: reader({status: "registered", mask: 4n})});
    expect(kinds).toEqual(["GOVERNMENT"]);
    expect(buildEntityCard(baseSettings(), true, kinds).kind).toBe("GOVERNMENT");
  });

  it("no registry configured: [VET], and the reader is never called", async () => {
    let called = false;
    const kinds = await resolveEntityCardKinds(
      {entityAccount: ACCOUNT},
      {registryAddress: "", read: async () => ((called = true), {status: "registered", mask: 4n})},
    );
    expect(kinds).toEqual(["VET"]);
    expect(called).toBe(false);
  });

  it("no entity account saved yet: [VET]", async () => {
    expect(await resolveEntityCardKinds({}, {registryAddress: REGISTRY, read: reader({status: "registered", mask: 4n})})).toEqual(["VET"]);
  });

  it("an unregistered account: [VET]", async () => {
    expect(await resolveEntityCardKinds({entityAccount: ACCOUNT}, {registryAddress: REGISTRY, read: reader({status: "not_registered"})})).toEqual(["VET"]);
  });

  it("a failed read (unreadable, or a throw): [VET], never an error", async () => {
    expect(await resolveEntityCardKinds({entityAccount: ACCOUNT}, {registryAddress: REGISTRY, read: reader({status: "unreadable"})})).toEqual(["VET"]);
    expect(await resolveEntityCardKinds({entityAccount: ACCOUNT}, {registryAddress: REGISTRY, read: reader(new Error("boom"))})).toEqual(["VET"]);
  });

  it("a mask with only bits this build does not know: [VET]", async () => {
    expect(await resolveEntityCardKinds({entityAccount: ACCOUNT}, {registryAddress: REGISTRY, read: reader({status: "registered", mask: 1n << 100n})})).toEqual(["VET"]);
  });
});
