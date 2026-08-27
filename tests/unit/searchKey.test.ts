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
});

describe("buildPetSearchKey", () => {
  it("joins name, species, and breed, lowercased", () => {
    expect(buildPetSearchKey({name: "Rex", species: "Dog", breed: "Labrador"})).toBe("rex dog labrador");
  });

  it("skips missing fields", () => {
    expect(buildPetSearchKey({name: "Whiskers", species: undefined, breed: undefined})).toBe("whiskers");
  });
});
