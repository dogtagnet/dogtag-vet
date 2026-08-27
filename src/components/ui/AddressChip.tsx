import {MonoValue} from "@/components/ui/MonoValue";
import {explorerUrl, type ExplorerChainKey} from "@/lib/explorer";

export interface AddressChipProps {
  address: string;
  chain?: ExplorerChainKey;
  label?: string;
}

/** `0x1234...ABCD` mono, copy on click, optional explorer link and label - design-system.md. */
export function AddressChip({address, chain, label}: AddressChipProps) {
  const href = chain ? explorerUrl(chain, "address", address) : undefined;
  return <MonoValue value={address} label={label} href={href || undefined} />;
}
