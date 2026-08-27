import { type TypedScalar } from "./types.js";
export interface FlatEntry {
    keyPath: string;
    scalar: TypedScalar;
}
/** Flatten a nested typed credential into pinned (keyPath, scalar) pairs. */
export declare function flatten(credential: unknown): FlatEntry[];
type Token = {
    kind: "key";
    key: string;
} | {
    kind: "index";
    idx: number;
};
/** Tokenize a pinned keyPath into segments (reserved chars make this unambiguous). */
export declare function tokenizeKeyPath(keyPath: string): Token[];
/** Rebuild a nested object/array of packed strings from flat (keyPath -> packed) pairs. */
export declare function unflatten(entries: Record<string, string>): unknown;
export {};
//# sourceMappingURL=flatten.d.ts.map