// Re-exports of the vendored contract ABIs (protocol/contracts/exports/abi/*.json, read-only) as
// typed constants for wagmi/viem. Never hand-transcribe an ABI - always import the vendored JSON.
import type {Abi} from "viem";
import VetIssuerFactoryAbiJson from "../../protocol/contracts/exports/abi/VetIssuerFactory.json";
import VetIssuerAbiJson from "../../protocol/contracts/exports/abi/VetIssuer.json";
import EntityRegistryAbiJson from "../../protocol/contracts/exports/abi/EntityRegistry.json";
import DogTagSBTConsentAbiJson from "../../protocol/contracts/exports/abi/DogTagSBTConsent.json";
import VerificationRegistryConsentAbiJson from "../../protocol/contracts/exports/abi/VerificationRegistryConsent.json";

// Cast through `unknown`: the vendored JSON's inferred TS shape (string-typed
// `stateMutability`/`type` fields) is wider than viem's `Abi` literal-union shape, even though the
// runtime values are exactly right. This never hides a real mismatch - wagmi/viem validate the ABI
// shape at call time against the actual contract, not against this type.
export const vetIssuerFactoryAbi = VetIssuerFactoryAbiJson as unknown as Abi;
export const vetIssuerAbi = VetIssuerAbiJson as unknown as Abi;
export const entityRegistryAbi = EntityRegistryAbiJson as unknown as Abi;
export const dogTagSBTConsentAbi = DogTagSBTConsentAbiJson as unknown as Abi;
export const verificationRegistryConsentAbi = VerificationRegistryConsentAbiJson as unknown as Abi;
