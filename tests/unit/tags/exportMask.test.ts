import {describe, expect, it} from "vitest";
import {validateExportMask} from "@/lib/tags/exportMask";

const ARTIFACT_KEY_PATHS = ["credentialSubject.name", "credentialSubject.species", "owner.identity.fullName"];

describe("validateExportMask (WP4.10V item 3's field-picker validation)", () => {
  it("an empty mask is always valid - the ordinary, fully-disclosed export", () => {
    expect(validateExportMask([], ARTIFACT_KEY_PATHS)).toEqual([]);
  });

  it("every entry that IS one of the artifact's own disclosed leaves is valid, including owner.identity.*", () => {
    expect(validateExportMask(["credentialSubject.name"], ARTIFACT_KEY_PATHS)).toEqual([]);
    expect(validateExportMask(["credentialSubject.name", "credentialSubject.species"], ARTIFACT_KEY_PATHS)).toEqual([]);
    // The non-maskable set is EMPTY (WP4.10S's own ruling) - owner.identity.* is an ordinary
    // attribute leaf here, maskable exactly like any other.
    expect(validateExportMask(["owner.identity.fullName"], ARTIFACT_KEY_PATHS)).toEqual([]);
  });

  it("masking EVERY leaf at once is valid - the fully-obfuscated case specs/leaf-commitment.md section 15 explicitly supports", () => {
    expect(validateExportMask(ARTIFACT_KEY_PATHS, ARTIFACT_KEY_PATHS)).toEqual([]);
  });

  it("rejects an unknown keyPath - not present among the artifact's own disclosed leaves", () => {
    expect(validateExportMask(["credentialSubject.nonexistent"], ARTIFACT_KEY_PATHS)).toEqual([
      {keyPath: "credentialSubject.nonexistent", reason: "unknown_keypath"},
    ]);
  });

  it("rejects a reserved owner-control keyPath the same way as any other unknown keyPath - it is never among artifact.leaves in the first place", () => {
    // owner.address/owner.consentKey/owner.secret never appear as a keyPath in artifact.leaves -
    // only as opaque reservedLeafHashes - so naming one here falls out as unknown_keypath, exactly
    // as this module's own file header explains (no separate reserved-namespace check needed).
    expect(validateExportMask(["owner.address"], ARTIFACT_KEY_PATHS)).toEqual([{keyPath: "owner.address", reason: "unknown_keypath"}]);
  });

  it("rejects a duplicate keyPath within the mask itself, reporting only the repeat occurrence", () => {
    expect(validateExportMask(["credentialSubject.name", "credentialSubject.name"], ARTIFACT_KEY_PATHS)).toEqual([
      {keyPath: "credentialSubject.name", reason: "duplicate"},
    ]);
  });

  it("reports every distinct problem, not just the first, in the order the entries were encountered", () => {
    const errors = validateExportMask(["credentialSubject.name", "bogus.one", "credentialSubject.name", "bogus.two"], ARTIFACT_KEY_PATHS);
    expect(errors).toEqual([
      {keyPath: "bogus.one", reason: "unknown_keypath"},
      {keyPath: "credentialSubject.name", reason: "duplicate"},
      {keyPath: "bogus.two", reason: "unknown_keypath"},
    ]);
  });

  it("a keyPath duplicated where the FIRST occurrence is itself unknown is reported once as unknown, not also as a duplicate on that first sighting", () => {
    const errors = validateExportMask(["bogus", "bogus"], ARTIFACT_KEY_PATHS);
    expect(errors).toEqual([
      {keyPath: "bogus", reason: "unknown_keypath"},
      {keyPath: "bogus", reason: "duplicate"},
    ]);
  });
});
