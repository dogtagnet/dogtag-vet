import type {PaymentChainKey} from "@/lib/chains";

/** `PaymentPublicStatusResponse.chain` per `vet-public-api.yaml`: "the chain the matching transfer
 * was observed on, e.g. `base-sepolia`". The internal camelCase `PaymentChainKey` is derived from
 * (and mechanically convertible to) that kebab-case wire form: split on the internal uppercase
 * boundary and lowercase-join with a dash. This is a total, systematic transform - not a lookup
 * table - so a future fifth chain key never needs a matching entry added here. */
export function chainKeyToWireChain(key: PaymentChainKey): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
