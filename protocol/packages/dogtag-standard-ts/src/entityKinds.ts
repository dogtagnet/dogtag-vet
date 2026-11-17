// Entity kinds: the kind registry helper (specs/entity-kinds.md, specs/entity-kinds.json).
//
// An EntityRegistry entity carries a SET of kinds as a uint256 mask, one bit per kind. Kinds are a record
// only - they grant no right - so this helper never fails on a bit it does not know: it drops it.
// The list below MUST equal specs/entity-kinds.json (test/entity_kinds.test.ts asserts that).

/** Public ids, in bit order. */
export const ENTITY_KIND_IDS = ["VET", "GOVERNMENT", "GROOMER", "BOARDING", "DAYCARE"] as const;

export type EntityKindId = (typeof ENTITY_KIND_IDS)[number];

export interface EntityKindInfo {
  /** Bit number in the on-chain mask. Equals the contract's EntityKind ordinal. Never reused. */
  readonly bit: number;
  readonly id: EntityKindId;
  /** English display name; clients may localise. */
  readonly label: string;
}

/** The registry, in bit order. Bit 0 is reserved and never set. */
export const ENTITY_KINDS: readonly EntityKindInfo[] = [
  {bit: 1, id: "VET", label: "Vet"},
  {bit: 2, id: "GOVERNMENT", label: "Government"},
  {bit: 3, id: "GROOMER", label: "Groomer"},
  {bit: 4, id: "BOARDING", label: "Boarding"},
  {bit: 5, id: "DAYCARE", label: "Daycare"},
];

const MASK_MAX = (1n << 256n) - 1n;

function assertMask(mask: bigint): void {
  if (typeof mask !== "bigint") throw new TypeError("entity kinds mask must be a bigint");
  if (mask < 0n || mask > MASK_MAX) throw new RangeError("entity kinds mask must fit in a uint256");
}

/**
 * The known kinds set in `mask`, in bit order. Bits this helper does not know (bit 0, and every bit above
 * the last registered kind) are dropped, never an error. A zero mask gives an empty list.
 */
export function entityKindsFromMask(mask: bigint): EntityKindId[] {
  assertMask(mask);
  const out: EntityKindId[] = [];
  for (const k of ENTITY_KINDS) {
    if ((mask >> BigInt(k.bit)) & 1n) out.push(k.id);
  }
  return out;
}

/**
 * The mask for a list of kind ids. Order does not matter.
 * Throws on an unknown id, on an empty list and on a duplicate id.
 */
export function maskFromEntityKinds(ids: readonly EntityKindId[]): bigint {
  if (ids.length === 0) throw new Error("entity kinds list is empty");
  let mask = 0n;
  const seen = new Set<string>();
  for (const id of ids) {
    const info = ENTITY_KINDS.find((k) => k.id === id);
    if (!info) throw new Error(`unknown entity kind id: ${String(id)}`);
    if (seen.has(id)) throw new Error(`duplicate entity kind id: ${id}`);
    seen.add(id);
    mask |= 1n << BigInt(info.bit);
  }
  return mask;
}

/** The primary kind: the lowest set bit this helper knows, or null when none is known. */
export function primaryEntityKind(mask: bigint): EntityKindId | null {
  return entityKindsFromMask(mask)[0] ?? null;
}
