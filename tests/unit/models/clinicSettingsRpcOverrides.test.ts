import {describe, expect, it} from "vitest";
import {ClinicSettings} from "@/lib/models/ClinicSettings";
import {paymentPublicClient} from "@/lib/paymentChainRead";

/**
 * WP4.18 - regression test for a pre-existing bug `e2e/roax-payment.spec.ts` discovered (the
 * `rpcOverrides` field had no `default: () => ({})`, unlike its sibling `businessProfile`, whose
 * own doc comment already explains exactly this class of bug). A freshly-constructed
 * `ClinicSettings` document - the shape `getClinicSettings()` creates on a brand-new deployment's
 * very first read - had `rpcOverrides` genuinely `undefined`, and `paymentPublicClient(chainKey,
 * rpcOverrides)` (`src/lib/paymentChainRead.ts`) unconditionally dereferences
 * `rpcOverrides[chainKey]`, so every payment-watcher scan on a brand-new clinic threw `Cannot read
 * properties of undefined (reading 'roax')`, on every tick, forever - until an operator happened
 * to save the Settings page once (which always sends a real `rpcOverrides` object, curing it from
 * that point on).
 *
 * Mongoose applies schema defaults at DOCUMENT CONSTRUCTION time (`new Model(...)`), not only on
 * save, so this needs no real database connection - `new ClinicSettings(...)` alone is enough to
 * prove the default actually attaches. Two layers are pinned separately since the first one
 * (the schema default + minimize:false at BOTH the field's own subdocument schema and the parent
 * `clinicSettingsSchema` - confirmed live neither alone is enough) turned out not to be the whole
 * fix on its own: `paymentPublicClient` also needed to read `rpcOverrides` defensively, to cover
 * every document written before this default existed at all (`getClinicSettings()`'s own backfill
 * handles that case for documents read through it specifically, but the defensive read protects
 * every caller unconditionally).
 */
describe("ClinicSettings.rpcOverrides - default value", () => {
  it("a freshly-constructed document has a real rpcOverrides object, never undefined", () => {
    const doc = new ClinicSettings({_id: "singleton"});
    expect(doc.rpcOverrides).toBeDefined();
    expect(doc.rpcOverrides).not.toBeNull();
  });

  it("survives serialization: toObject() still carries a real (empty) rpcOverrides object", () => {
    const doc = new ClinicSettings({_id: "singleton"});
    expect(doc.toObject().rpcOverrides).toEqual({});
  });

  it("paymentPublicClient does not throw when given a freshly-constructed document's rpcOverrides", () => {
    const doc = new ClinicSettings({_id: "singleton"});
    // toObject() to get the same plain-object shape `.lean()` reads produce elsewhere in the app -
    // paymentPublicClient itself never touches Mongo, so this is a pure, fast, in-memory check.
    expect(() => paymentPublicClient("roax", doc.toObject().rpcOverrides)).not.toThrow();
  });

  it("paymentPublicClient does not throw even when rpcOverrides is genuinely undefined (a pre-existing document from before this default existed)", () => {
    expect(() => paymentPublicClient("roax", undefined)).not.toThrow();
  });
});
