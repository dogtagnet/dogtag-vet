import {AddressChip} from "@/components/ui/AddressChip";
import {HashCell} from "@/components/ui/HashCell";
import {formatUnixSeconds} from "@/lib/format";
import type {ExplorerChainKey} from "@/lib/explorer";

export interface TimelineEntry {
  id: string;
  timestamp: number; // unix seconds
  actor?: string;
  eventName: string;
  txHash?: string;
  chain?: ExplorerChainKey;
  detail?: string;
}

export interface TimelineProps {
  entries: TimelineEntry[];
  emptyMessage?: string;
}

/** On-chain event history and audit trails: timestamp, actor chip, event name, tx link -
 * design-system.md's Timeline. */
export function Timeline({entries, emptyMessage}: TimelineProps) {
  if (entries.length === 0) {
    return <p className="text-body text-ink-faint">{emptyMessage ?? "No activity yet."}</p>;
  }

  return (
    <ol className="relative space-y-0 border-l border-border pl-5">
      {entries.map((entry) => (
        <li key={entry.id} className="relative pb-5 last:pb-0">
          <span className="absolute -left-[25px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-brand" />
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-body font-medium text-ink">{entry.eventName}</span>
            <span className="text-caption text-ink-faint">{formatUnixSeconds(entry.timestamp)}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            {entry.actor && <AddressChip address={entry.actor} chain={entry.chain} label="actor" />}
            {entry.txHash && <HashCell value={entry.txHash} chain={entry.chain} kind="tx" label="tx" />}
          </div>
          {entry.detail && <p className="mt-1 text-body text-ink-muted">{entry.detail}</p>}
        </li>
      ))}
    </ol>
  );
}
