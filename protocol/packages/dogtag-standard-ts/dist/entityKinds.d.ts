/** Public ids, in bit order. */
export declare const ENTITY_KIND_IDS: readonly ["VET", "GOVERNMENT", "GROOMER", "BOARDING", "DAYCARE"];
export type EntityKindId = (typeof ENTITY_KIND_IDS)[number];
export interface EntityKindInfo {
    /** Bit number in the on-chain mask. Equals the contract's EntityKind ordinal. Never reused. */
    readonly bit: number;
    readonly id: EntityKindId;
    /** English display name; clients may localise. */
    readonly label: string;
}
/** The registry, in bit order. Bit 0 is reserved and never set. */
export declare const ENTITY_KINDS: readonly EntityKindInfo[];
/**
 * The known kinds set in `mask`, in bit order. Bits this helper does not know (bit 0, and every bit above
 * the last registered kind) are dropped, never an error. A zero mask gives an empty list.
 */
export declare function entityKindsFromMask(mask: bigint): EntityKindId[];
/**
 * The mask for a list of kind ids. Order does not matter.
 * Throws on an unknown id, on an empty list and on a duplicate id.
 */
export declare function maskFromEntityKinds(ids: readonly EntityKindId[]): bigint;
/** The primary kind: the lowest set bit this helper knows, or null when none is known. */
export declare function primaryEntityKind(mask: bigint): EntityKindId | null;
//# sourceMappingURL=entityKinds.d.ts.map