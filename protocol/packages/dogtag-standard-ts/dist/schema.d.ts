export declare const DOGTAG_CONTEXT_URI = "https://dogtag.io/credentials/v1";
export declare class SchemaError extends Error {
    readonly violations: string[];
    constructor(violations: string[]);
}
type Json = unknown;
type Obj = Record<string, Json>;
/**
 * Validate a credential object. Returns the credential on success;
 * throws {@link SchemaError} (with all violations) on failure.
 */
export declare function validateSchema<T extends Obj>(credential: T): T;
export {};
//# sourceMappingURL=schema.d.ts.map