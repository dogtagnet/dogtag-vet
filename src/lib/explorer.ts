import {paymentChainByKey, type PaymentChainKey} from "@/lib/chains";

/** Was `"roax" | PaymentChainKey` before WP4.18: `"roax"` was the identity chain, distinct from
 * (and excluded from) the payment-chain union. Now that ROAX is the only payment chain too
 * (`PaymentChainKey` = `"roax"`), the two collapsed to the same type - kept as its own alias
 * rather than inlined so call sites (`AddressChip`, `HashCell`) don't need to change if a second
 * chain is ever added back. */
export type ExplorerChainKey = PaymentChainKey;

type ExplorerKind = "address" | "tx" | "token";

/** Single source of truth for block-explorer links. Every AddressChip and HashCell in the app
 * routes through this instead of hand-building a URL, so a chain's explorer base only ever needs
 * to change in one place. Registry-driven (`paymentChainByKey`), not a special-cased single chain,
 * for the same forward-compat reason `chains.ts`'s own doc comment gives. */
export function explorerUrl(chain: ExplorerChainKey, kind: ExplorerKind, value: string): string {
  const base = paymentChainByKey[chain].blockExplorers?.default.url;
  if (!base) return "";
  const segment = kind === "tx" ? "tx" : kind === "token" ? "token" : "address";
  return `${base.replace(/\/$/, "")}/${segment}/${value}`;
}
