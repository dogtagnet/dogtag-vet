import "server-only";
import {createPublicClient, http, keccak256, toBytes, type Address} from "viem";
import {roax} from "@/lib/chains";
import {getServerEnv} from "@/lib/env";
import {vetIssuerAbi, entityRegistryAbi, dogTagSBTConsentAbi, verificationRegistryConsentAbi} from "@/lib/abi";

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

/** The current ROAX head block number - the wallet-registration EIP-712 message's `blockNumber`
 * field (plans/wp4.2-client-wallet-registration.md: "ROAX head at session creation, server-
 * fetched; session creation FAILS if the RPC is unreachable - chain presence is part of the
 * receipt"). Fail-closed like every other read in this file: an RPC failure throws rather than
 * resolving to a guessed value; `lib/registration/createSession.ts` is what turns that throw into
 * the route's `chain_unreachable` result. */
export async function readRoaxBlockNumber(): Promise<bigint> {
  return roaxPublicClient().getBlockNumber();
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
