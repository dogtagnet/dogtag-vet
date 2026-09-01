import {describe, expect, it} from "vitest";
import {visibleGroups} from "@/components/shell/Sidebar";
import {navGroups} from "@/components/shell/nav";

/**
 * WP4.7 A2: the sidebar hides the whole "DogTag" nav group (Tags, Issue tag, Verify,
 * Verification history, On-chain activity) for a plain `staff` session - the UI half of the same
 * `isVetOrOwner` gate `requireVetSession` and the `/tags`/`/tags/issue` page redirects enforce
 * (`tests/unit/models/staffRoleGuard.test.ts`). Every OTHER group must stay untouched regardless
 * of role - this is a visibility filter, not a re-authorization of the whole nav.
 */
describe("Sidebar.visibleGroups", () => {
  const dogTagGroup = navGroups.find((g) => g.label === "DogTag");

  it("the DogTag group actually exists in nav.ts (sanity check the fixture this suite depends on)", () => {
    expect(dogTagGroup).toBeDefined();
    expect(dogTagGroup!.items.length).toBeGreaterThan(0);
  });

  it.each(["vet", "owner"] as const)("keeps every group, including DogTag, for role %s", (role) => {
    expect(visibleGroups(role)).toEqual(navGroups);
  });

  it("hides only the DogTag group for plain staff", () => {
    const groups = visibleGroups("staff");
    expect(groups.some((g) => g.label === "DogTag")).toBe(false);
    expect(groups.length).toBe(navGroups.length - 1);
    // Every other group survives unchanged, in the same order.
    expect(groups).toEqual(navGroups.filter((g) => g.label !== "DogTag"));
  });

  it("hides the DogTag group for an undefined role too (unauthenticated/loading - fail closed)", () => {
    expect(visibleGroups(undefined).some((g) => g.label === "DogTag")).toBe(false);
  });
});
