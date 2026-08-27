// Shared types for the DogTag standard (mirror of dogtag-standard-rs).
/** Mandatory type tag so `"5"` (string) != `5` (integer). impl §1.1 / §3.2. */
export var TypeTag;
(function (TypeTag) {
    TypeTag[TypeTag["Null"] = 0] = "Null";
    TypeTag[TypeTag["Bool"] = 1] = "Bool";
    TypeTag[TypeTag["String"] = 2] = "String";
    TypeTag[TypeTag["Integer"] = 3] = "Integer";
    TypeTag[TypeTag["Decimal"] = 4] = "Decimal";
    TypeTag[TypeTag["Bytes"] = 5] = "Bytes";
})(TypeTag || (TypeTag = {}));
/**
 * The `owner.` namespace is RESERVED for owner-control profile-tree leaves (current and future);
 * `owner.identity.*` is the one sanctioned carve-out, for vet-attested human-identity attribute
 * leaves (D1). Mirrors `dogtag-standard-rs::profile_tree::{OWNER_NAMESPACE_PREFIX,
 * OWNER_IDENTITY_PREFIX}`. Shared by `disclosure.ts` and `profileBind.ts` so the two surfaces that
 * police this boundary cannot drift apart on the literal.
 */
export const OWNER_NAMESPACE_PREFIX = "owner.";
export const OWNER_IDENTITY_PREFIX = "owner.identity.";
/** May this issuer-whitelist state contribute to a pass? Only a definite PASSED does, plus the one
 * case that is this verifier's own gap rather than evidence about the credential. */
export function issuerWhitelistPermitsPass(s) {
    return s === "PASSED" || s === "UNAVAILABLE_NO_FACTORY_CONFIGURED";
}
/** May this term contribute to a pass? Only a definite DIFFERS refuses. */
export function issuerStorePermitsPass(s) {
    return s !== "DIFFERS";
}
//# sourceMappingURL=types.js.map