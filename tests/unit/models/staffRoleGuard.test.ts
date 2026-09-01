import {describe, expect, it} from "vitest";
import {wouldRemoveActiveOwnerStatus} from "@/lib/models/Staff";

/**
 * The last-owner guard `PATCH /api/settings/staff/:staffId` enforces (combined with a fresh
 * `countActiveOwners()` read there) - pure and DB-free so every branch, including the WP4.7 A1
 * regression this exists to catch, is directly testable: before the third role existed, the guard
 * could have been written as a hardcoded `role !== "owner" -> becomes staff` check that happened to
 * also catch `vet` only by using `!== "owner"` rather than `=== "staff"`. This suite pins that the
 * REAL implementation generalizes correctly rather than merely happening to.
 */
describe("wouldRemoveActiveOwnerStatus", () => {
  const activeOwner = {role: "owner" as const, disabled: false};

  it("trips when an active owner is demoted to staff", () => {
    expect(wouldRemoveActiveOwnerStatus(activeOwner, {role: "staff"})).toBe(true);
  });

  it("trips when an active owner is demoted to vet (the new role - not a hardcoded staff-only check)", () => {
    expect(wouldRemoveActiveOwnerStatus(activeOwner, {role: "vet"})).toBe(true);
  });

  it("trips when an active owner is disabled outright, with no role change", () => {
    expect(wouldRemoveActiveOwnerStatus(activeOwner, {disabled: true})).toBe(true);
  });

  it("trips when an active owner is BOTH demoted and disabled in the same patch", () => {
    expect(wouldRemoveActiveOwnerStatus(activeOwner, {role: "vet", disabled: true})).toBe(true);
  });

  it("does not trip when the role patch keeps them as owner", () => {
    expect(wouldRemoveActiveOwnerStatus(activeOwner, {role: "owner"})).toBe(false);
  });

  it("does not trip when the patch touches neither role nor disabled", () => {
    expect(wouldRemoveActiveOwnerStatus(activeOwner, {})).toBe(false);
  });

  it("does not trip when disabled is explicitly set to false (restoring, not revoking)", () => {
    expect(wouldRemoveActiveOwnerStatus(activeOwner, {disabled: false})).toBe(false);
  });

  it("does not trip for a target that is already disabled - it was not an ACTIVE owner to begin with", () => {
    expect(wouldRemoveActiveOwnerStatus({role: "owner", disabled: true}, {role: "staff"})).toBe(false);
  });

  it.each(["staff", "vet"] as const)("does not trip for a non-owner target (%s), regardless of the patch", (role) => {
    expect(wouldRemoveActiveOwnerStatus({role, disabled: false}, {role: "owner", disabled: true})).toBe(false);
  });
});
