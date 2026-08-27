import {paymentChainByKey, roax, type PaymentChainKey} from "@/lib/chains";

export type ExplorerChainKey = "roax" | PaymentChainKey;

type ExplorerKind = "address" | "tx" | "token";

/** Single source of truth for block-explorer links. Every AddressChip and HashCell in the app
 * routes through this instead of hand-building a URL, so a chain's explorer base only ever needs
 * to change in one place. */
export function explorerUrl(chain: ExplorerChainKey, kind: ExplorerKind, value: string): string {
  const base = chain === "roax" ? roax.blockExplorers?.default.url : paymentChainByKey[chain].blockExplorers?.default.url;
  if (!base) return "";
  const segment = kind === "tx" ? "tx" : kind === "token" ? "token" : "address";
  return `${base.replace(/\/$/, "")}/${segment}/${value}`;
}
