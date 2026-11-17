import {beforeEach, describe, expect, it} from "vitest";
import {buildEntityCard} from "@/lib/entityCard";
import {clearEntityCardKindsCache, resolveEntityCardKinds} from "@/lib/entityCardKinds";
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
  beforeEach(() => clearEntityCardKindsCache());

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

  describe("deadline and cache", () => {
    /** A manual clock plus a manual timer: `advance` moves time and fires due timers. */
    function fakeTime() {
      let t = 1_000_000;
      let nextId = 1;
      const timers = new Map<number, {at: number; fn: () => void}>();
      return {
        now: () => t,
        setTimer: (fn: () => void, ms: number) => {
          const id = nextId++;
          timers.set(id, {at: t + ms, fn});
          return id;
        },
        clearTimer: (h: unknown) => void timers.delete(h as number),
        advance(ms: number) {
          t += ms;
          for (const [id, timer] of [...timers]) {
            if (timer.at <= t) {
              timers.delete(id);
              timer.fn();
            }
          }
        },
        pending: () => timers.size,
      };
    }
    const countingReader = (answers: Array<EntityKindsRead | "hang">) => {
      let calls = 0;
      const read = (async () => {
        const answer = answers[Math.min(calls, answers.length - 1)];
        calls++;
        if (answer === "hang") return new Promise<EntityKindsRead>(() => undefined);
        return answer;
      }) as unknown as typeof import("@/lib/chainRead").readEntityKinds;
      return {read, calls: () => calls};
    };
    const settings = {entityAccount: ACCOUNT};

    it("a second call inside the TTL does not read; a call after expiry reads again", async () => {
      const time = fakeTime();
      const {read, calls} = countingReader([{status: "registered", mask: 8n}, {status: "registered", mask: 4n}]);
      const deps = {registryAddress: REGISTRY, read, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer};
      expect(await resolveEntityCardKinds(settings, deps)).toEqual(["GROOMER"]);
      time.advance(59_999);
      expect(await resolveEntityCardKinds(settings, deps)).toEqual(["GROOMER"]);
      expect(calls()).toBe(1);
      time.advance(1);
      expect(await resolveEntityCardKinds(settings, deps)).toEqual(["GOVERNMENT"]);
      expect(calls()).toBe(2);
    });

    it("a not_registered answer is cached for the long TTL", async () => {
      const time = fakeTime();
      const {read, calls} = countingReader([{status: "not_registered"}]);
      const deps = {registryAddress: REGISTRY, read, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer};
      await resolveEntityCardKinds(settings, deps);
      time.advance(59_000);
      await resolveEntityCardKinds(settings, deps);
      expect(calls()).toBe(1);
    });

    it("a read that never resolves returns [VET] at the deadline and is cached for the short TTL", async () => {
      const time = fakeTime();
      const {read, calls} = countingReader(["hang"]);
      const deps = {registryAddress: REGISTRY, read, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer};
      const first = resolveEntityCardKinds(settings, deps);
      await Promise.resolve();
      let settled = false;
      void first.then(() => (settled = true));
      await new Promise((r) => setTimeout(r, 0));
      expect(settled).toBe(false);
      time.advance(2499);
      await new Promise((r) => setTimeout(r, 0));
      expect(settled).toBe(false);
      time.advance(1);
      expect(await first).toEqual(["VET"]);
      expect(calls()).toBe(1);
      time.advance(29_999);
      expect(await resolveEntityCardKinds(settings, deps)).toEqual(["VET"]);
      expect(calls()).toBe(1);
      time.advance(1);
      void resolveEntityCardKinds(settings, deps);
      await new Promise((r) => setTimeout(r, 0));
      expect(calls()).toBe(2);
    });

    it("a successful read after a cached failure replaces it once the short TTL passes", async () => {
      const time = fakeTime();
      const {read, calls} = countingReader([{status: "unreadable"}, {status: "registered", mask: 4n}]);
      const deps = {registryAddress: REGISTRY, read, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer};
      expect(await resolveEntityCardKinds(settings, deps)).toEqual(["VET"]);
      time.advance(29_999);
      expect(await resolveEntityCardKinds(settings, deps)).toEqual(["VET"]);
      expect(calls()).toBe(1);
      time.advance(1);
      expect(await resolveEntityCardKinds(settings, deps)).toEqual(["GOVERNMENT"]);
      time.advance(31_000);
      expect(await resolveEntityCardKinds(settings, deps)).toEqual(["GOVERNMENT"]);
      expect(calls()).toBe(2);
    });

    it("two concurrent calls share one read, and the deadline timer is cleared after a fast read", async () => {
      const time = fakeTime();
      let release!: (v: EntityKindsRead) => void;
      let calls = 0;
      const read = (() => {
        calls++;
        return new Promise<EntityKindsRead>((resolve) => (release = resolve));
      }) as unknown as typeof import("@/lib/chainRead").readEntityKinds;
      const deps = {registryAddress: REGISTRY, read, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer};
      const a = resolveEntityCardKinds(settings, deps);
      const b = resolveEntityCardKinds(settings, deps);
      release({status: "registered", mask: 10n});
      expect(await Promise.all([a, b])).toEqual([["VET", "GROOMER"], ["VET", "GROOMER"]]);
      expect(calls).toBe(1);
      expect(time.pending()).toBe(0);
    });
  });
});
