import type {PaymentChainKey} from "@/lib/chains";

/** `PaymentPublicStatusResponse.chain` per `vet-public-api.yaml`: "the chain the matching transfer
 * was observed on" - today always `roax` (WP4.18: ROAX is the only payment chain). The internal
 * camelCase `PaymentChainKey` is derived from (and mechanically convertible to) that kebab-case
 * wire form: split on the internal uppercase boundary and lowercase-join with a dash - a total,
 * systematic transform (not a lookup table), so a future second chain key never needs a matching
 * entry added here (and, having no uppercase letters, `roax` itself is already a fixed point of
 * this transform). */
export function chainKeyToWireChain(key: PaymentChainKey): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
