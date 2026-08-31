import {describe, expect, it} from "vitest";
import {buildClientSearchKey} from "@/lib/models/Client";
import {buildPetSearchKey} from "@/lib/models/Pet";

describe("buildClientSearchKey", () => {
  it("joins name, email, and phone, lowercased", () => {
    expect(buildClientSearchKey({name: "Jane Doe", email: "Jane@Example.com", phone: "555-1234"})).toBe(
      "jane doe jane@example.com 555-1234",
    );
  });

  it("skips missing fields without leaving stray separators", () => {
    expect(buildClientSearchKey({name: "Jane Doe", email: undefined, phone: undefined})).toBe("jane doe");
  });

  it("collapses internal whitespace", () => {
    expect(buildClientSearchKey({name: "Jane   Doe", email: undefined, phone: undefined})).toBe("jane doe");
  });

  it("never includes idDocNumber, even when the caller passes a wider client object through", () => {
    // WP4.3 A2 (normative): idDocNumber is deliberately excluded from the searchable key - no ID
    // numbers in a substring-searchable index. buildClientSearchKey's own parameter type already
    // only picks {name, email, phone}, but a caller can still structurally pass a full ClientDoc
    // (extra properties are allowed) - this proves the exclusion holds even then, not just that
    // the signature happens to be narrow.
    const wideClient = {
      name: "Jane Doe",
      email: "jane@example.com",
      phone: "555-1234",
      idDocType: "passport" as const,
      idDocNumber: "P1234567",
    };
    const key = buildClientSearchKey(wideClient);
    expect(key).toBe("jane doe jane@example.com 555-1234");
    expect(key).not.toContain("p1234567");
    expect(key).not.toContain("passport");
  });
});

describe("buildPetSearchKey", () => {
  it("joins name, species, and breed, lowercased", () => {
    expect(buildPetSearchKey({name: "Rex", species: "Dog", breed: "Labrador"})).toBe("rex dog labrador");
  });

  it("skips missing fields", () => {
    expect(buildPetSearchKey({name: "Whiskers", species: undefined, breed: undefined})).toBe("whiskers");
  });
});
