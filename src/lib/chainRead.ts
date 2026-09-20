import "server-only";
import {createPublicClient, http, keccak256, toBytes, TransactionReceiptNotFoundError, type Address, type Hex} from "viem";
import {roax} from "@/lib/chains";
import {getServerEnv} from "@/lib/env";
import {vetIssuerAbi, vetIssuerFactoryAbi, entityRegistryAbi, dogTagSBTConsentAbi, verificationRegistryConsentAbi, delegationRegistryAbi} from "@/lib/abi";

/**
 * Server-side read-only ROAX client. This repo never holds a private key server-side (wp4-vet.md's
 * "no server-held private keys" definition-of-done item) - every chain WRITE goes through a
 * connected staff wallet via wagmi in the browser. This client exists purely for the reads the
 * server itself must make fail-closed and independent of what the browser claims: dogTagId
 * allocation, the custodial-bind seal check, and the issue-confirmation re-read (wp4-vet.md,
 * "DogTag issuance" steps 2 and 5 - "a receipt is not proof").
 */
let cachedClient: ReturnType<typeof createPublicClient> | undefined;

export function roaxPublicClient() {
  if (!cachedClient) {
    cachedClient = createPublicClient({
      chain: roax,
      transport: http(getServerEnv().ROAX_RPC_URL),
    });
  }
  return cachedClient;
}

/** Every read below is fail-closed by construction: a revert or an RPC/network failure propagates
 * as a thrown error rather than resolving to a default value, so a caller that forgets to catch it
 * fails the whole request instead of silently treating "unreadable" as "false"/"unset". This is
 * the exact property wp4-vet.md's dogTagId allocation step demands ("an unreadable chain refuses,
 * never guess") and it is deliberately generalized to every other preflight read here too. */

const ZERO_HEX32 = `0x${"0".repeat(64)}` as const;

/** `DogTagSBTConsent.profileRoot(dogTagIdField)` - the root anchored for this id, or the all-zero
 * hash if never issued. `dogTagIdField` is passed as its canonical decimal-string form. */
export async function readProfileRoot(sbtAddress: Address, dogTagIdFieldDec: string): Promise<string> {
  const root = await roaxPublicClient().readContract({
    address: sbtAddress,
    abi: dogTagSBTConsentAbi,
    functionName: "profileRoot",
    args: [BigInt(dogTagIdFieldDec)],
  });
  return root as string;
}

export async function isProfileRootUnset(sbtAddress: Address, dogTagIdFieldDec: string): Promise<boolean> {
  const root = await readProfileRoot(sbtAddress, dogTagIdFieldDec);
  return root.toLowerCase() === ZERO_HEX32;
}

/** `VetIssuer.isValid(root)` on the specific clone that anchored it. */
export async function readIsValidRoot(cloneAddress: Address, root: string): Promise<boolean> {
  return (await roaxPublicClient().readContract({
    address: cloneAddress,
    abi: vetIssuerAbi,
    functionName: "isValid",
    args: [root as `0x${string}`],
  })) as boolean;
}

/** `DogTagSBTConsent.status(dogTagIdField)` - the tag's own lifecycle status (0 Active, 1 Lost,
 * 2 TransferPending, 3 Deceased, 4 Revoked). WP4.15's own `DelegationRegistry.add`/`revoke`
 * deliberately do NOT check this on chain (`DelegationRegistry.sol`'s doc comment: "the
 * terminal-status rule is therefore enforced entirely by consumers... not by this contract" -
 * `docs/DELEGATION.md` section 4.6 leaves it an open implementation choice since Stage A's
 * ceremony has no ZK consent check for the future delegate-proof registry to enforce it at
 * either). Kenneth's decision (plan section 9 item 7: "Terminal tags: YES - survive Lost/
 * TransferPending, frozen on Deceased/Revoked") is therefore enforced HERE, at the app layer, as
 * this repo's own defense-in-depth precondition on the add/revoke ceremony - see
 * `isTerminalSbtStatus` below and its call sites in `src/lib/delegation/`. */
export async function readSbtStatus(sbtAddress: Address, dogTagIdFieldDec: string): Promise<number> {
  return Number(
    await roaxPublicClient().readContract({
      address: sbtAddress,
      abi: dogTagSBTConsentAbi,
      functionName: "status",
      args: [BigInt(dogTagIdFieldDec)],
    }),
  );
}

/** `VetIssuerFactory.rootIssuer(root)` - the clone address that indexed `root` via
 * `VetIssuer.issueTag`/`issueRecord`'s own `factory.indexRoot(root)` call (write-once, atomic with
 * the issuance itself), or the zero address when no clone has ever indexed it. This is the ONE
 * helper WP4.4 adds to this file - modelled directly on the readers above (fail-closed: an
 * unreadable chain throws rather than resolving to a guessed answer). Used by the mobile-booking
 * tag-claim tiers (`lib/booking/mobileReconcile.ts`) to tell "issued by THIS clinic, just unlinked
 * locally" apart from "issued by someone else" apart from "never issued anywhere" - the same
 * distinction iOS's `ChainReads.rootIssuer` makes for the verify flow. */
export async function readRootIssuer(factoryAddress: Address, root: string): Promise<Address> {
  return (await roaxPublicClient().readContract({
    address: factoryAddress,
    abi: vetIssuerFactoryAbi,
    functionName: "rootIssuer",
    args: [root as `0x${string}`],
  })) as Address;
}

/** `VetIssuer.operators(address)` - whether `operator` is whitelisted on this clone right now. */
export async function readOperatorWhitelisted(cloneAddress: Address, operator: Address): Promise<boolean> {
  return (await roaxPublicClient().readContract({
    address: cloneAddress,
    abi: vetIssuerAbi,
    functionName: "operators",
    args: [operator],
  })) as boolean;
}

/** `EntityRegistry.isActive(account)`. */
export async function readEntityActive(entityRegistryAddress: Address, account: Address): Promise<boolean> {
  return (await roaxPublicClient().readContract({
    address: entityRegistryAddress,
    abi: entityRegistryAbi,
    functionName: "isActive",
    args: [account],
  })) as boolean;
}

/** `EntityRegistry.canVerify(purpose, relayer)` - `purpose` is hashed the same way `purposeToBytes32`
 * hashes it everywhere else in this repo (never re-derived ad hoc at a call site). */
export async function readCanVerify(
  entityRegistryAddress: Address,
  purpose: string,
  relayer: Address,
): Promise<boolean> {
  return (await roaxPublicClient().readContract({
    address: entityRegistryAddress,
    abi: entityRegistryAbi,
    functionName: "canVerify",
    args: [purposeToBytes32(purpose), relayer],
  })) as boolean;
}

/** `VerificationRegistryConsent.consumed(nullifier)` - whether this nullifier has already been
 * spent on chain (replay check). */
export async function readNullifierConsumed(
  verificationRegistryAddress: Address,
  nullifierHex: string,
): Promise<boolean> {
  return (await roaxPublicClient().readContract({
    address: verificationRegistryAddress,
    abi: verificationRegistryConsentAbi,
    functionName: "consumed",
    args: [nullifierHex as `0x${string}`],
  })) as boolean;
}

/** `VetIssuer.RECORD_TYPE_PROFILE()` - the keccak256-derived record-type constant for a profile
 * tree credential, read from the clone itself rather than re-hashed here, per
 * `specs/issuer-attestation.md` ("recordType ... never a free string"). */
export async function readRecordTypeProfile(cloneAddress: Address): Promise<string> {
  return (await roaxPublicClient().readContract({
    address: cloneAddress,
    abi: vetIssuerAbi,
    functionName: "RECORD_TYPE_PROFILE",
  })) as string;
}

/** `VetIssuer.RECORD_TYPE_VACCINATION()` (WP4.14) - the vaccination-record-type constant, read
 * from the clone itself for the SAME "never a free string" reason `readRecordTypeProfile` is - the
 * C3 attestation message for a vaccination record (`api/records/[id]/attestation/route.ts`) needs
 * this exact on-chain value, not a locally re-hashed one. */
export async function readRecordTypeVaccination(cloneAddress: Address): Promise<string> {
  return (await roaxPublicClient().readContract({
    address: cloneAddress,
    abi: vetIssuerAbi,
    functionName: "RECORD_TYPE_VACCINATION",
  })) as string;
}

/** `VetIssuer.recordTypeOf(root)` (WP4.14) - the per-ROOT record-type mapping
 * (`contracts/src/VetIssuer.sol`'s `mapping(bytes32 => bytes32) public recordTypeOf`), populated
 * by BOTH the original tag-issuance path and `issueRecord(recordType, root)`. Returns the all-zero
 * hash for a root this mapping has never seen - callers MUST treat that as "not this record type",
 * never as a pass (specs/leaf-commitment.md section 16's on-chain binding rule 2). Read from the
 * RESOLVED clone (never a clone the caller merely claims), exactly like `readIssuedBy`. */
export async function readRecordTypeOf(cloneAddress: Address, root: string): Promise<string> {
  return (await roaxPublicClient().readContract({
    address: cloneAddress,
    abi: vetIssuerAbi,
    functionName: "recordTypeOf",
    args: [root as `0x${string}`],
  })) as string;
}

/** The current ROAX head block number - the wallet-registration EIP-712 message's `blockNumber`
 * field (plans/wp4.2-client-wallet-registration.md: "ROAX head at session creation, server-
 * fetched; session creation FAILS if the RPC is unreachable - chain presence is part of the
 * receipt"). Fail-closed like every other read in this file: an RPC failure throws rather than
 * resolving to a guessed value; `lib/registration/createSession.ts` is what turns that throw into
 * the route's `chain_unreachable` result. */
export async function readRoaxBlockNumber(): Promise<bigint> {
  return roaxPublicClient().getBlockNumber();
}

/**
 * The `issueTag`/`revokeTag`/... transaction's own mined receipt status. `"pending"` covers ONLY
 * "not mined yet" (`getTransactionReceipt` throwing `TransactionReceiptNotFoundError` - the normal
 * shape of "still in flight"), never a genuine RPC/network failure, which propagates as a thrown
 * error like every other read in this file (this function's own doc comment above, "fail-closed by
 * construction") - WP4.5 track 3's reverted-tx detection (`reconcileAnchoredSession`) is the one
 * caller today, and it treats `"pending"` as "not conclusive, fall through to the ordinary
 * anchored check" while an unreadable chain still fails the whole reconcile closed.
 */
export async function readTxReceiptStatus(txHash: Hex): Promise<"success" | "reverted" | "pending"> {
  try {
    const receipt = await roaxPublicClient().getTransactionReceipt({hash: txHash});
    return receipt.status === "reverted" ? "reverted" : "success";
  } catch (err) {
    if (err instanceof TransactionReceiptNotFoundError) return "pending";
    throw err;
  }
}

export interface TxAnchoring {
  blockNumber: number;
  blockTime: Date;
}

/**
 * The mined block number + timestamp of an already-`"success"` transaction (WP4.14 V3's "active +
 * anchoring from the receipt (block number, block timestamp)"). Only ever called once `readTxReceiptStatus`
 * has already reported `"success"` for the same hash - a receipt carries a block NUMBER only, so the
 * timestamp needs a second read (`getBlock`) against that same number. Fail-closed like every other
 * read in this file: a pending/nonexistent receipt throws via `getTransactionReceipt` itself, never
 * resolves to a guessed value.
 */
export async function readTxAnchoring(txHash: Hex): Promise<TxAnchoring> {
  const receipt = await roaxPublicClient().getTransactionReceipt({hash: txHash});
  const block = await roaxPublicClient().getBlock({blockNumber: receipt.blockNumber});
  return {blockNumber: Number(receipt.blockNumber), blockTime: new Date(Number(block.timestamp) * 1000)};
}

/** `VetIssuer.issuedBy(root)` - the operator wallet that actually anchored `root` on this clone,
 * set to `msg.sender` inside `issueTag`/`issueRecord` (`onlyOperator`). This is the sole correct
 * gate for accepting a C3 issuer attestation's signer (`specs/issuer-attestation.md`: "The signer
 * MUST be the operator wallet that actually anchored merkleRoot ... at issuance"); a *current*
 * whitelist check would be wrong here (the spec is explicit that delisting is forward-only, so a
 * since-rotated-out operator's past anchor must still verify). Returns the zero address when
 * `root` was never anchored on this clone. */
export async function readIssuedBy(cloneAddress: Address, root: `0x${string}`): Promise<Address> {
  return (await roaxPublicClient().readContract({
    address: cloneAddress,
    abi: vetIssuerAbi,
    functionName: "issuedBy",
    args: [root],
  })) as Address;
}

/**
 * WP4.15 multi-owner (PLANNED - `DelegationRegistry` is not deployed on any real chain yet). Four
 * reads against the registry itself, never the clone (`addSecondaryOwner`/`revokeSecondaryOwner`
 * are clone functions that call INTO the registry - see `chainWrite.ts` - but every read of "what
 * is this tag's delegate set right now" goes straight to the registry, the single source of truth
 * `docs/DELEGATION.md` section 4.2 describes). All four are fail-closed like every other reader in
 * this file - an unreadable chain throws, never resolves to a guessed answer.
 */

/** `DelegationRegistry.isSecondary(dogTagId, commitment)` - is `commitment` a CURRENTLY active
 * secondary owner of `dogTagIdFieldDec`? The decisive confirm-time check (V3): a concurrent,
 * unrelated add/revoke on the same tag can move `secondaryCount`/`delegationRoot` for reasons that
 * have nothing to do with THIS write, but `isSecondary` for the specific commitment this write
 * just added or removed can only flip because of it. */
export async function readIsSecondary(delegationRegistryAddress: Address, dogTagIdFieldDec: string, commitment: Hex): Promise<boolean> {
  return (await roaxPublicClient().readContract({
    address: delegationRegistryAddress,
    abi: delegationRegistryAbi,
    functionName: "isSecondary",
    args: [BigInt(dogTagIdFieldDec), commitment],
  })) as boolean;
}

/** `DelegationRegistry.secondaryCount(dogTagId)` - count of CURRENTLY active secondaries. The
 * session-start cap pre-check (`checkDelegationCapNotReached`) and part of the confirm-time audit
 * trail (never the decisive confirm check on its own - see `readIsSecondary`'s doc comment). */
export async function readSecondaryCount(delegationRegistryAddress: Address, dogTagIdFieldDec: string): Promise<number> {
  const count = (await roaxPublicClient().readContract({
    address: delegationRegistryAddress,
    abi: delegationRegistryAbi,
    functionName: "secondaryCount",
    args: [BigInt(dogTagIdFieldDec)],
  })) as bigint;
  return Number(count);
}

/** `DelegationRegistry.delegationRoot(dogTagId)` - part of the confirm-time audit trail only
 * (`docs/DELEGATION.md` section 4.2: emptiness is `secondaryCount == 0`, never a root comparison -
 * this value is recorded for display/logging, never branched on for correctness). */
export async function readDelegationRoot(delegationRegistryAddress: Address, dogTagIdFieldDec: string): Promise<Hex> {
  return (await roaxPublicClient().readContract({
    address: delegationRegistryAddress,
    abi: delegationRegistryAbi,
    functionName: "delegationRoot",
    args: [BigInt(dogTagIdFieldDec)],
  })) as Hex;
}

/** `DelegationRegistry.delegationLeaves(dogTagId)` - the tag's current 16 physical tree slots
 * (`docs/DELEGATION.md` section 4.2), needed in full both for the Owners card's chain-authoritative
 * active/revoked join (one read, not N `isSecondary` calls) and for `DelegationCoOwnerBundle`'s
 * own `delegationLeaves` field (V4) - `specs/vet-public-api.yaml`: "folding fewer than 16 values
 * produces a different tree than the one `delegationRoot` actually commits to", so this must always
 * be the live, full 16-element chain read, never reconstructed from Mongo. */
export async function readDelegationLeaves(delegationRegistryAddress: Address, dogTagIdFieldDec: string): Promise<Hex[]> {
  return (await roaxPublicClient().readContract({
    address: delegationRegistryAddress,
    abi: delegationRegistryAbi,
    functionName: "delegationLeaves",
    args: [BigInt(dogTagIdFieldDec)],
  })) as Hex[];
}

/**
 * No vendored ReasonCodes or verify-purpose constant table ships with this protocol snapshot
 * (`protocol/specs/events.md` and the flattened contracts only ever name a `reasonCode`/`purpose`
 * *parameter*, never a fixed list of values) - so this repo defines its own, deriving each bytes32
 * constant the same way `RECORD_TYPE_PROFILE` etc. are documented to be derived
 * (`specs/issuer-attestation.md`: "the keccak256-derived constant ... never a free string"):
 * `keccak256(utf8Bytes(name))`. Both the vet's own read (`readCanVerify`) and its own writes
 * (`revokeTag`/`reactivateTag` reason codes) go through this single function so every caller
 * derives the identical bytes32 for the identical name.
 */
export function purposeToBytes32(name: string): `0x${string}` {
  return keccak256(toBytes(name));
}
