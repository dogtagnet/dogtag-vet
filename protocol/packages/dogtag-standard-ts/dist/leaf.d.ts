import { type Field } from "./field.js";
import { type TypedScalar } from "./types.js";
export declare function fieldOfKeyPath(keyPath: string): Field;
export declare function fieldOfValue(s: TypedScalar): Field;
/** hashLeaf — Poseidon over the canonical (keyPath, salt, typeTag, value) tuple. */
export declare function hashLeaf(keyPath: string, salt: Uint8Array, s: TypedScalar): Field;
//# sourceMappingURL=leaf.d.ts.map