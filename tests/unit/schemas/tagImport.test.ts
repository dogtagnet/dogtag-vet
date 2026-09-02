import {describe, expect, it} from "vitest";
import {TypeTag} from "@dogtag/standard";
import {importCompleteSchema} from "@/lib/schemas/tagImport";

/**
 * WP4.10V item 6 TRANSITION (orchestrator ruling, P2 finding) - direct coverage of
 * `importCompleteSchema`'s `leaves`/`disclosed` dual-alias acceptance, the piece that actually
 * fixes the hazard: WP4.9M's shipped `ArtifactShareEngine` sends `leaves` only (no `disclosed`, no
 * `obfuscatedLeafHashes`) and MUST keep completing imports unchanged; a future WP4.10M client will
 * send `disclosed`; a body sending both must agree or be rejected. This is the schema layer
 * `completeImport`'s own tests (`tests/unit/tags/importFlow.test.ts`) never exercise, since by the
 * time a request reaches `completeImport` the schema has already normalized it to one `leaves`
 * field - this file is what actually proves the normalization itself.
 */

const RESERVED = ["0x" + "1".repeat(64), "0x" + "2".repeat(64), "0x" + "3".repeat(64)];
const LEAF_A = {keyPath: "credentialSubject.name", saltHex: `0x${"aa".repeat(16)}`, tag: TypeTag.String, value: "Rex"};
const LEAF_B = {keyPath: "credentialSubject.species", saltHex: `0x${"bb".repeat(16)}`, tag: TypeTag.String, value: "dog"};
const HASH_A = "0x" + "4".repeat(64);

function baseBody(overrides: Record<string, unknown> = {}) {
  return {dogTagIdField: "123456", reservedLeafHashes: RESERVED, ...overrides};
}

describe("importCompleteSchema (WP4.10V item 6's leaves/disclosed dual-alias transition)", () => {
  it("WP4.9M-shaped payload: leaves only, no disclosed, no obfuscatedLeafHashes - accepted and normalized unchanged", () => {
    const parsed = importCompleteSchema.safeParse(baseBody({leaves: [LEAF_A, LEAF_B]}));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.leaves).toEqual([LEAF_A, LEAF_B]);
    expect(parsed.data.obfuscatedLeafHashes).toBeUndefined();
    expect("disclosed" in parsed.data).toBe(false);
  });

  it("WP4.10M-shaped payload: disclosed only, normalized into the same canonical leaves field", () => {
    const parsed = importCompleteSchema.safeParse(baseBody({disclosed: [LEAF_A, LEAF_B]}));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.leaves).toEqual([LEAF_A, LEAF_B]);
  });

  it("a WP4.10M-shaped masked payload: disclosed (subset) + obfuscatedLeafHashes both accepted", () => {
    const parsed = importCompleteSchema.safeParse(baseBody({disclosed: [LEAF_A], obfuscatedLeafHashes: [HASH_A]}));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.leaves).toEqual([LEAF_A]);
    expect(parsed.data.obfuscatedLeafHashes).toEqual([HASH_A]);
  });

  it("both leaves and disclosed present, IDENTICAL content - accepted (a client sending both defensively during the transition)", () => {
    const parsed = importCompleteSchema.safeParse(baseBody({leaves: [LEAF_A, LEAF_B], disclosed: [LEAF_A, LEAF_B]}));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.leaves).toEqual([LEAF_A, LEAF_B]);
  });

  it("both leaves and disclosed present, DIFFERING content - rejected, never silently picks one", () => {
    const parsed = importCompleteSchema.safeParse(baseBody({leaves: [LEAF_A], disclosed: [LEAF_B]}));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const flat = parsed.error.flatten();
    expect(flat.fieldErrors.disclosed?.some((m) => m.includes("differ") || m.includes("describe different"))).toBe(true);
  });

  it("both leaves and disclosed present, same leaves but different ORDER - still rejected (order is part of the claim)", () => {
    const parsed = importCompleteSchema.safeParse(baseBody({leaves: [LEAF_A, LEAF_B], disclosed: [LEAF_B, LEAF_A]}));
    expect(parsed.success).toBe(false);
  });

  it("neither leaves nor disclosed present - rejected, submitting verification data is the whole point", () => {
    const parsed = importCompleteSchema.safeParse(baseBody({}));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const flat = parsed.error.flatten();
    expect(flat.fieldErrors.leaves).toBeDefined();
  });

  it("joint 64-leaf cap: reserved(3) + leaves(61) + obfuscatedLeafHashes(1) = 65 is rejected", () => {
    const sixtyOneLeaves = Array.from({length: 61}, (_, i) => ({...LEAF_A, keyPath: `credentialSubject.attr${i}`}));
    const parsed = importCompleteSchema.safeParse(baseBody({leaves: sixtyOneLeaves, obfuscatedLeafHashes: [HASH_A]}));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.flatten().fieldErrors.obfuscatedLeafHashes).toBeDefined();
  });

  it("joint 64-leaf cap: reserved(3) + leaves(60) + obfuscatedLeafHashes(1) = 64 is accepted (exactly at the cap)", () => {
    const sixtyLeaves = Array.from({length: 60}, (_, i) => ({...LEAF_A, keyPath: `credentialSubject.attr${i}`}));
    const parsed = importCompleteSchema.safeParse(baseBody({leaves: sixtyLeaves, obfuscatedLeafHashes: [HASH_A]}));
    expect(parsed.success).toBe(true);
  });

  it("schemaId, when present, is threaded through unchanged", () => {
    const parsed = importCompleteSchema.safeParse(baseBody({leaves: [LEAF_A], schemaId: "https://dogtag.io/schemas/dog-profile/v1"}));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.schemaId).toBe("https://dogtag.io/schemas/dog-profile/v1");
  });

  it("schemaId absent stays absent - never invented", () => {
    const parsed = importCompleteSchema.safeParse(baseBody({leaves: [LEAF_A]}));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.schemaId).toBeUndefined();
  });
});
