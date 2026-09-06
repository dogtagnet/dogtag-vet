import {describe, expect, it} from "vitest";
import {mintProfileSchema, startMintSessionSchema} from "@/lib/schemas/mintSession";

/**
 * WP4.12V item 8 - `mintProfileSchema`'s three new leaves (Kenneth issue 2):
 * `color`/`registrationId`/`registrationAuthority`, trimmed optional strings capped at 120 -
 * exactly `staff.ts`'s firstName/lastName/displayName length convention, but WITHOUT `.min(1)`:
 * an empty string is a valid "no value" input here, matching every other existing profile field
 * (`species`, `breedVbo`, `breedLabel`).
 */
describe("mintProfileSchema - color/registrationId/registrationAuthority", () => {
  it("accepts all three when present and within the length cap", () => {
    const parsed = mintProfileSchema.safeParse({
      weightHistory: [],
      color: "brown",
      registrationId: "SGP-DOG-0042",
      registrationAuthority: "AVS Singapore",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.color).toBe("brown");
    expect(parsed.data.registrationId).toBe("SGP-DOG-0042");
    expect(parsed.data.registrationAuthority).toBe("AVS Singapore");
  });

  it("trims surrounding whitespace", () => {
    const parsed = mintProfileSchema.safeParse({weightHistory: [], color: "  brown  "});
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.color).toBe("brown");
  });

  it("accepts an empty string - not .min(1), same as species/breedVbo/breedLabel", () => {
    const parsed = mintProfileSchema.safeParse({weightHistory: [], color: "", registrationId: "", registrationAuthority: ""});
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.color).toBe("");
  });

  it("accepts all three entirely absent - every field is optional", () => {
    const parsed = mintProfileSchema.safeParse({weightHistory: []});
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.color).toBeUndefined();
    expect(parsed.data.registrationId).toBeUndefined();
    expect(parsed.data.registrationAuthority).toBeUndefined();
  });

  it("accepts exactly 120 characters (the boundary)", () => {
    const exactly120 = "a".repeat(120);
    const parsed = mintProfileSchema.safeParse({weightHistory: [], color: exactly120});
    expect(parsed.success).toBe(true);
  });

  it("rejects 121 characters - one over the cap - independently for each of the three fields", () => {
    const tooLong = "a".repeat(121);
    expect(mintProfileSchema.safeParse({weightHistory: [], color: tooLong}).success).toBe(false);
    expect(mintProfileSchema.safeParse({weightHistory: [], registrationId: tooLong}).success).toBe(false);
    expect(mintProfileSchema.safeParse({weightHistory: [], registrationAuthority: tooLong}).success).toBe(false);
  });

  /**
   * The nested-schema reality TagIssueWizard.tsx's own `profileError` comment relies on: a
   * `profile.color` validation failure surfaces through `startMintSessionSchema`'s zod error at
   * path `["profile", "color"]`, which `error.flatten().fieldErrors` buckets under the single
   * top-level key `"profile"` (path[0]) - it cannot say which of the profile's fields failed.
   * Pinned here so a future change to either schema's nesting depth is caught by this exact test,
   * not rediscovered by re-deriving it from the client code's own comment.
   */
  it("a too-long profile.color surfaces at startMintSessionSchema's top level as fieldErrors.profile (flatten() cannot see past the first path segment)", () => {
    const parsed = startMintSessionSchema.safeParse({
      clientId: "client-1",
      petName: "Rex",
      ownerIdentity: {},
      profile: {weightHistory: [], color: "a".repeat(121)},
      operatorAddress: `0x${"1".repeat(40)}`,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const flat = parsed.error.flatten();
    expect(flat.fieldErrors.profile?.length).toBeGreaterThan(0);
    // `fieldErrors` has no `color` key AT THE TYPE LEVEL for this schema (TS: Property 'color'
    // does not exist on the fieldErrors type) - the strongest possible confirmation that flatten()
    // cannot see past "profile", the first path segment, stronger than a runtime `toBeUndefined()`
    // could ever be.
    expect(Object.keys(flat.fieldErrors)).toEqual(["profile"]);
  });
});
