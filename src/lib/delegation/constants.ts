/**
 * WP4.15 multi-owner (PLANNED - `DelegationRegistry` is not deployed on any real chain yet;
 * `docs/DEPLOY-wp4.15.md` on the `dogtag-protocol` branch `feature/wp4.15-multi-owner` is
 * Kenneth's own pending deployment runbook). Shared constants for the vet-issued secondary-owner
 * ceremony - `docs/DELEGATION.md` section 4.2 in that same branch is the normative reference.
 */

/** Fixed tree width: depth-4, 16 leaf slots (plan section 10 item 5; section 13 settlement) -
 * matches `DelegationRegistry.sol`'s own `TREE_SIZE` exactly. */
export const DELEGATION_TREE_SIZE = 16;

/** Cap on ACTIVE secondaries per tag (plan section 10 item 5: "cap raised to 11 secondaries per
 * tag (depth-4 tree, 16 leaves; 11 is fine)") - matches `DelegationRegistry.sol`'s own
 * `MAX_ACTIVE`. Checked here too (session-start pre-check, before any ceremony is run) so staff
 * are told "this tag already has 11 secondary owners" up front rather than discovering it only
 * after a QR round trip and a reverted on-chain call. */
export const DELEGATION_MAX_ACTIVE = 11;

/**
 * The fold of sixteen all-zero delegation-tree leaves - `DelegationRegistry.delegationRoot`'s
 * value for a `dogTagId` that has never had a secondary owner, or has had every one revoked
 * (`docs/DELEGATION.md` section 4.2; `DelegationRegistry.sol`'s own `EMPTY_DELEGATION_ROOT`
 * constant). Pinned here as a literal (not computed at runtime) purely for the `e2e/rpcStub.ts`
 * default and this app's own display code, which never has a live `DelegationRegistry` to read
 * from in a test environment before anything has been added.
 *
 * **Never a test for emptiness.** `docs/DELEGATION.md` section 4.2 is explicit: test emptiness
 * with `secondaryCount == 0`, never by comparing a root against `0` or against this constant - a
 * `DelegationRegistry` implementation is free to store literal `0` for a never-touched tag and
 * only ever produce this exact fold once every member has since been revoked, so a comparison
 * against either specific value cannot distinguish those two cases from each other. This constant
 * exists for the stub default and for display ("this tag has no secondary owners yet"), not for
 * any correctness-load-bearing branch.
 *
 * Independently re-derived (not merely retyped from `DelegationRegistry.sol`'s own comment) in
 * `tests/unit/delegation/constants.test.ts`, using the vendored `@dogtag/standard`'s own
 * `buildMerkle`/`toHex32` over sixteen zero leaves - the same probe `docs/DELEGATION.md` section
 * 4.2 itself documents having used to produce this exact value.
 */
export const EMPTY_DELEGATION_ROOT = "0x08cec144526c6d771c4aad65ad4e8054bc21e6f09b8bdf27c13ba39643fa8ddc" as const;
