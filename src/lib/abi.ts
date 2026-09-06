// Re-exports of the vendored contract ABIs (protocol/contracts/exports/abi/*.json, read-only) as
// typed constants for wagmi/viem. Never hand-transcribe an ABI - always import the vendored JSON.
import type {Abi} from "viem";
import VetIssuerFactoryAbiJson from "../../protocol/contracts/exports/abi/VetIssuerFactory.json";
import VetIssuerAbiJson from "../../protocol/contracts/exports/abi/VetIssuer.json";
import EntityRegistryAbiJson from "../../protocol/contracts/exports/abi/EntityRegistry.json";
import DogTagSBTConsentAbiJson from "../../protocol/contracts/exports/abi/DogTagSBTConsent.json";
import VerificationRegistryConsentAbiJson from "../../protocol/contracts/exports/abi/VerificationRegistryConsent.json";
// WP4.15 (PLANNED - not yet deployed to any real chain; vendored from the dogtag-protocol BRANCH
// `feature/wp4.15-multi-owner`, not master - see protocol/PROVENANCE.md). `VetIssuerAbiJson` above
// is ALSO this branch's 2.1.0 copy (addSecondaryOwner/revokeSecondaryOwner/relayVerification/
// initializeDelegation), not master's 2.0.0 - both vendored files moved together.
import DelegationRegistryAbiJson from "../../protocol/contracts/exports/abi/DelegationRegistry.json";

// Cast through `unknown`: the vendored JSON's inferred TS shape (string-typed
// `stateMutability`/`type` fields) is wider than viem's `Abi` literal-union shape, even though the
// runtime values are exactly right. This never hides a real mismatch - wagmi/viem validate the ABI
// shape at call time against the actual contract, not against this type.
export const vetIssuerFactoryAbi = VetIssuerFactoryAbiJson as unknown as Abi;
export const vetIssuerAbi = VetIssuerAbiJson as unknown as Abi;
export const entityRegistryAbi = EntityRegistryAbiJson as unknown as Abi;
export const dogTagSBTConsentAbi = DogTagSBTConsentAbiJson as unknown as Abi;
export const verificationRegistryConsentAbi = VerificationRegistryConsentAbiJson as unknown as Abi;
export const delegationRegistryAbi = DelegationRegistryAbiJson as unknown as Abi;

// The generic ERC-20 `Transfer` event (and `decimals`, used only for display/sanity checks, never
// for computing amountBase - that always comes from the token registry so a misreporting contract
// can never shift what the watcher considers a match). Not protocol-vendored: ERC-20 is a public
// standard, not a DogTag contract, so hand-writing this minimal ABI slice does not run afoul of
// "never reimplement protocol crypto/contracts" - there is no protocol source to vendor it from.
export const erc20Abi = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      {name: "from", type: "address", indexed: true},
      {name: "to", type: "address", indexed: true},
      {name: "value", type: "uint256", indexed: false},
    ],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{name: "", type: "uint8"}],
  },
] as unknown as Abi;
