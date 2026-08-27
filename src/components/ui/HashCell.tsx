import {MonoValue} from "@/components/ui/MonoValue";
import {explorerUrl, type ExplorerChainKey} from "@/lib/explorer";

export interface HashCellProps {
  value: string;
  chain?: ExplorerChainKey;
  kind?: "tx" | "root" | "doc";
  label?: string;
}

/** Same mono/truncate/copy treatment as AddressChip, for roots, tx hashes, and document hashes -
 * design-system.md. `kind: "root"` and `"doc"` never link out (there is no explorer route for a
 * bare hash); only `"tx"` resolves to an explorer link when a chain is given. */
export function HashCell({value, chain, kind = "tx", label}: HashCellProps) {
  const href = chain && kind === "tx" ? explorerUrl(chain, "tx", value) : undefined;
  return <MonoValue value={value} label={label} href={href || undefined} />;
}
