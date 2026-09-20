import type {Address, Hex} from "viem";

/**
 * The `DelegationClaim` EIP-712 struct - `docs/DELEGATION.md` section 4.3 step 4 / plan section
 * 13 (both in the `dogtag-protocol` branch `feature/wp4.15-multi-owner`), one level up from
 * `ClientRegistration` (`lib/registration/eip712.ts`): a claim about a specific tag and a specific
 * fresh delegate-key commitment, rather than a bare wallet binding. THE non-negotiable exact,
 * ordered type list (no spaces in the `encodeType` string - `tests/unit/delegation/eip712.test.ts`
 * pins the literal keccak256 typeHash preimage so a field-order typo can never pass unnoticed):
 *
 * `DelegationClaim(address clinic,uint256 dogTagIdField,bytes32 commitment,bytes32 registrationId,address wallet,uint64 issuedAt,uint64 blockNumber,uint64 deadline)`
 */
export const DELEGATION_CLAIM_PRIMARY_TYPE = "DelegationClaim" as const;

export const DELEGATION_CLAIM_TYPES = {
  DelegationClaim: [
    {name: "clinic", type: "address"},
    {name: "dogTagIdField", type: "uint256"},
    {name: "commitment", type: "bytes32"},
    {name: "registrationId", type: "bytes32"},
    {name: "wallet", type: "address"},
    {name: "issuedAt", type: "uint64"},
    {name: "blockNumber", type: "uint64"},
    {name: "deadline", type: "uint64"},
  ],
} as const;

export interface DelegationClaimDomain {
  name: "DogTagDelegationClaim";
  version: "1";
  chainId: number;
  verifyingContract: Address;
}

/** `clinic` and `verifyingContract` carry the same clone address redundantly - mirrors
 * `buildClientRegistrationDomain`'s own `clinic`/`verifyingContract` pairing exactly
 * (`docs/DELEGATION.md` section 4.3 step 4: "the same clone address redundantly, exactly like
 * ClientRegistration's own clinic field"). */
export function buildDelegationClaimDomain(chainId: number, verifyingContract: Address): DelegationClaimDomain {
  return {name: "DogTagDelegationClaim", version: "1", chainId, verifyingContract};
}

/** The struct's field values in the shape viem's `recoverTypedDataAddress`/`hashTypedData`/
 * `signTypedData` want: the three `uint64` fields as `bigint`, never `number` - see
 * `eip712ClientRegistration.vectors.test.ts`'s own doc comment on why `Number()` is unsafe at
 * 2^64-1, which applies identically here. */
export interface DelegationClaimMessage {
  clinic: Address;
  dogTagIdField: bigint;
  commitment: Hex;
  registrationId: Hex; // right-padded bytes32 - lib/registration/uuid.ts's registrationIdToHex32
  wallet: Address;
  issuedAt: bigint;
  blockNumber: bigint;
  deadline: bigint;
}

/** Same field values, wire-encoded for JSON transport - the `uint256`/`uint64` fields as decimal
 * strings, matching this app's own `ClientRegistrationMessageWire` convention. */
export interface DelegationClaimMessageWire {
  clinic: Address;
  dogTagIdField: string;
  commitment: Hex;
  registrationId: Hex;
  wallet: Address;
  issuedAt: string;
  blockNumber: string;
  deadline: string;
}

export function toWireDelegationMessage(message: DelegationClaimMessage): DelegationClaimMessageWire {
  return {
    clinic: message.clinic,
    dogTagIdField: message.dogTagIdField.toString(10),
    commitment: message.commitment,
    registrationId: message.registrationId,
    wallet: message.wallet,
    issuedAt: message.issuedAt.toString(10),
    blockNumber: message.blockNumber.toString(10),
    deadline: message.deadline.toString(10),
  };
}
