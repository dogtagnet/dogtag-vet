import {formatEther} from "viem";
import {PageHeader} from "@/components/shell/PageHeader";
import {Timeline, type TimelineEntry} from "@/components/ui/Timeline";
import {Banner} from "@/components/ui/Banner";
import {connectToDatabase} from "@/lib/db";
import {ChainActivity, type ChainActivityDoc} from "@/lib/models/ChainActivity";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {roaxPublicClient} from "@/lib/chainRead";
import {reasonCodeLabel} from "@/lib/reasonCodes";

function StatTile({label, value, hint}: {label: string; value: string; hint?: string}) {
  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-card">
      <p className="text-caption uppercase tracking-wide text-ink-muted">{label}</p>
      <p className="mt-1 text-hero text-ink">{value}</p>
      {hint && <p className="mt-1 text-caption text-ink-faint">{hint}</p>}
    </div>
  );
}

/**
 * `/activity` - this clinic's clone timeline (wp4-vet.md), populated by `src/worker/index.ts`'s
 * chunked-getLogs follower. `GasRefunded` is named in wp4-vet.md but this protocol snapshot's
 * `VetIssuer` ABI has no such event (`protocol/contracts/exports/events.json` confirms) - the
 * refund-spend tile below counts `RefundSkipped` instead (the one refund-related event that
 * actually exists) and documents the gap rather than inventing a listener for an event that is
 * never emitted.
 */
export default async function Page() {
  await connectToDatabase();
  const [entries, settings] = await Promise.all([
    ChainActivity.find({})
      .sort({blockNumber: -1, logIndex: -1})
      .limit(200)
      .lean<ChainActivityDoc[]>(),
    getClinicSettings(),
  ]);

  let balance: bigint | null = null;
  if (settings.cloneAddress) {
    try {
      balance = await roaxPublicClient().getBalance({address: settings.cloneAddress as `0x${string}`});
    } catch {
      balance = null;
    }
  }
  const refundSkippedCount = entries.filter((e) => e.type === "RefundSkipped").length;

  const timelineEntries: TimelineEntry[] = entries.map((e) => ({
    id: e.id,
    timestamp: e.blockTimestamp,
    actor: e.operator,
    eventName: e.type,
    txHash: e.txHash,
    chain: "roax",
    detail: e.reasonCode
      ? `Reason: ${reasonCodeLabel(e.reasonCode) ?? e.reasonCode}`
      : e.dogTagId
        ? `dogTagId ${e.dogTagId}`
        : undefined,
  }));

  return (
    <>
      <PageHeader title="On-chain activity" description="This clinic's clone, SBT, and verification events." />
      {!settings.cloneAddress && (
        <Banner tone="warn" title="Setup incomplete">
          Finish the setup wizard to start following this clinic&apos;s clone.
        </Banner>
      )}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatTile label="Clone balance" value={balance !== null ? `${formatEther(balance)} PLASMA` : "-"} hint="Gas refund reserve" />
        <StatTile label="Refunds skipped" value={String(refundSkippedCount)} hint="Low balance at issuance time" />
        <StatTile label="Events tracked" value={String(entries.length)} />
      </div>
      <Timeline entries={timelineEntries} emptyMessage="No on-chain activity yet - issue a tag or run the worker to start following this clone." />
    </>
  );
}
