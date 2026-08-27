import { type Field } from "./field.js";
import { TypeTag, type IssuerMeta, type TypedScalar, type WrappedDoc } from "./types.js";
export type SaltProvider = () => Uint8Array;
/** parse(packed): split on the FIRST TWO ":" only (value may contain ":"). impl §11.2 F2b. */
export declare function parsePacked(packed: string): {
    saltHex: string;
    tag: TypeTag;
    valueRest: string;
};
/** Reconstruct a TypedScalar from a packed `tag:valueRest`. */
export declare function scalarFromPacked(tag: TypeTag, valueRest: string): TypedScalar;
/** Recompute the leaf hash for one packed entry (used by verify + obfuscate). */
export declare function leafFromPacked(keyPath: string, packed: string): Field;
/** Collect every (keyPath, packed) pair from a nested `data` object. */
export declare function flattenData(data: unknown): Array<[string, string]>;
/** wrapDocument — typed input -> single Poseidon root R (impl §1.4). */
export declare function wrapDocument(typedCredential: unknown, issuer: IssuerMeta, saltProvider?: SaltProvider): WrappedDoc;
/** obfuscate — move a field's leaf hash into privacy.obfuscated[] and drop its cleartext. Root unchanged. */
export declare function obfuscate(doc: WrappedDoc, keyPaths: string[]): WrappedDoc;
//# sourceMappingURL=wrap.d.ts.map