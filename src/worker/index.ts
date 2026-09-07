/**
 * The background worker process (`pnpm worker`, run via `tsx --conditions=react-server` per
 * package.json - see `src/lib/env.ts`'s doc comment on why that flag matters here). Three jobs,
 * all named in wp4-vet.md, running as two independent polling loops (`main`, below):
 *
 * 1. Boot recovery (once, at startup): a `MintSession` left `issuing` when a previous process died
 *    mid-flight (the tx was sent but this process never got to read back the confirmation) is
 *    reconciled to `bound` if its tag actually anchored on chain, back to `ready` if its tx
 *    confirmed REVERTED (WP4.5 track 3), or otherwise - once genuinely stale, never a seconds-old
 *    in-flight issuance - marked `interrupted` so it shows up as retryable rather than silently
 *    stuck forever (`recoverInterruptedSessions`, `src/lib/mint/bootRecovery.ts`). WP4.14 adds the
 *    identical recovery for a `RecordArtifact` left `issuing` (`recoverInterruptedRecords`,
 *    `src/lib/records/bootRecovery.ts`) - back to `draft` on a confirmed revert, since a record's
 *    leaves/root are already computed and already verified, so no redraft is ever needed.
 *    WP4.15 (PLANNED) adds the same recovery for a `DelegationSession` left `"submitting"`
 *    (`recoverStuckDelegationSessions`, `src/lib/delegation/bootRecovery.ts`).
 * 2. The chain-activity follower for `/activity` (`runActivityFollowerLoop`): chunked `getLogs`
 *    over this clinic's clone (`TagIssued`/`TagRevoked`/`TagReactivated`/`RecordIssued`/
 *    `RecordRevoked`/`RecordReactivated`/`FundsReceived`/`RefundSkipped`), plus `StatusChanged` on
 *    `DogTagSBTConsent` and `Verified` on `VerificationRegistryConsent` - both of the latter are
 *    contracts SHARED across every vet on the protocol, so their logs are filtered down to just
 *    this clinic's own `dogTagId`s (read from the local `Pet` collection) before being stored,
 *    per wp4-vet.md's "this clinic's clone + ... for this clinic" scoping.
 * 3. The payment watcher (`runPaymentWatcherLoop`, `src/lib/payments/watcher.ts`): scans the four
 *    payment chains for matching transfers to open invoices, marks them paid, fires receipt/notice
 *    emails, and sweeps past-due payments to `expired`.
 */
import {connectToDatabase} from "@/lib/db";
import {getServerEnv} from "@/lib/env";
import {getClinicSettings, updateClinicSettings} from "@/lib/models/ClinicSettings";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {ChainActivity} from "@/lib/models/ChainActivity";
import {roaxPublicClient} from "@/lib/chainRead";
import {vetIssuerAbi, dogTagSBTConsentAbi, verificationRegistryConsentAbi} from "@/lib/abi";
import {recoverInterruptedSessions} from "@/lib/mint/bootRecovery";
import {recoverInterruptedRecords} from "@/lib/records/bootRecovery";
import {recoverStuckDelegationSessions} from "@/lib/delegation/bootRecovery";
import {runPaymentWatcherOnce} from "@/lib/payments/watcher";
import type {Log} from "viem";

interface DecodedEventLog extends Log {
  eventName?: string;
  args?: Record<string, unknown>;
}

function toActivityDoc(log: DecodedEventLog, blockTimestamp: number) {
  const args = log.args ?? {};
  return {
    id: `${log.transactionHash}:${log.logIndex}`,
    type: log.eventName ?? "Unknown",
    blockNumber: Number(log.blockNumber),
    txHash: log.transactionHash!,
    logIndex: Number(log.logIndex),
    blockTimestamp,
    dogTagId:
      typeof args.dogTagIdField === "bigint"
        ? args.dogTagIdField.toString()
        : typeof args.dogTagId === "bigint"
          ? args.dogTagId.toString()
          : undefined,
    root: typeof args.root === "string" ? args.root : undefined,
    reasonCode: typeof args.reasonCode === "string" ? args.reasonCode : undefined,
    operator: (args.operator ?? args.by ?? args.relayer) as string | undefined,
    raw: args,
  };
}

async function upsertActivity(logs: DecodedEventLog[], client: ReturnType<typeof roaxPublicClient>): Promise<void> {
  for (const log of logs) {
    const block = await client.getBlock({blockNumber: log.blockNumber!});
    await ChainActivity.updateOne(
      {id: `${log.transactionHash}:${log.logIndex}`},
      {$setOnInsert: toActivityDoc(log, Number(block.timestamp))},
      {upsert: true},
    );
  }
}

const CLONE_EVENT_NAMES = [
  "TagIssued",
  "TagRevoked",
  "TagReactivated",
  "RecordIssued",
  "RecordRevoked",
  "RecordReactivated",
  "FundsReceived",
  "RefundSkipped",
] as const;

async function followOnce(): Promise<void> {
  const env = getServerEnv();
  const settings = await getClinicSettings();
  if (!settings.cloneAddress) return; // setup not finished yet - nothing to follow

  const client = roaxPublicClient();
  const latest = await client.getBlockNumber();
  const fromBlock = BigInt(settings.activityCursorBlock ?? env.ACTIVITY_START_BLOCK);
  if (fromBlock > latest) return;

  const knownDogTagIds = new Set(
    (await Pet.find({"dogTag.dogTagIdField": {$exists: true}}).select("dogTag.dogTagIdField").lean<PetDoc[]>()).map(
      (p) => p.dogTag.dogTagIdField!,
    ),
  );

  const chunk = BigInt(env.ACTIVITY_CHUNK_BLOCKS);
  let cursor = fromBlock;
  while (cursor <= latest) {
    const toBlock = cursor + chunk - 1n > latest ? latest : cursor + chunk - 1n;

    const cloneLogs = (await client.getContractEvents({
      address: settings.cloneAddress as `0x${string}`,
      abi: vetIssuerAbi,
      fromBlock: cursor,
      toBlock,
    })) as DecodedEventLog[];
    const relevantCloneLogs = cloneLogs.filter((l) => CLONE_EVENT_NAMES.includes(l.eventName as never));

    let sbtLogs: DecodedEventLog[] = [];
    let verifyLogs: DecodedEventLog[] = [];
    if (knownDogTagIds.size > 0) {
      try {
        const sbtAddress = env.DOGTAG_SBT_ADDRESS as `0x${string}` | undefined;
        if (sbtAddress) {
          const all = (await client.getContractEvents({
            address: sbtAddress,
            abi: dogTagSBTConsentAbi,
            eventName: "StatusChanged",
            fromBlock: cursor,
            toBlock,
          })) as DecodedEventLog[];
          sbtLogs = all.filter((l) => knownDogTagIds.has(String(l.args?.dogTagId)));
        }
        const verificationRegistryAddress = env.VERIFICATION_REGISTRY_ADDRESS as `0x${string}` | undefined;
        if (verificationRegistryAddress) {
          const all = (await client.getContractEvents({
            address: verificationRegistryAddress,
            abi: verificationRegistryConsentAbi,
            eventName: "Verified",
            fromBlock: cursor,
            toBlock,
          })) as DecodedEventLog[];
          // WP4.15 multi-owner (PLANNED) item V5 - "verification history shows the role (primary/
          // secondary) once the delegate circuit ships". Today's `Verified` event (the primary
          // owner's own 7-signal consent proof) carries no role signal at all - `docs/DELEGATION.md`
          // section 4.4's future delegate consent proof adds `role` as its NINTH public signal, on
          // a Stage C registry contract that does not exist yet (needs a mainnet-grade ceremony
          // first). Once it ships, the analogous event on that new contract gains a `role` field
          // this same fold would decode and `/activity`'s Timeline (`toActivityDoc` above) would
          // surface it - there is nothing to display before then, so this comment is the "document"
          // half of V5 rather than a UI stub for a field that cannot exist yet.
          verifyLogs = all.filter((l) => knownDogTagIds.has(String(l.args?.dogTagId)));
        }
      } catch (err) {
        console.error("[worker] SBT/verification log fetch failed, continuing with clone logs only", err);
      }
    }

    await upsertActivity([...relevantCloneLogs, ...sbtLogs, ...verifyLogs], client);
    await updateClinicSettings({activityCursorBlock: Number(toBlock) + 1});
    cursor = toBlock + 1n;
  }
}

/** The payment watcher's own loop (`src/lib/payments/watcher.ts`) - a second, independent
 * `setInterval`-style loop alongside the chain-activity follower's, per this file's original doc
 * comment anticipating exactly this addition. Deliberately not merged into `followOnce`'s loop:
 * the two watch entirely different chains (ROAX vs. the four payment chains) on different
 * cadences, and a failure in one must never stall the other. */
async function runPaymentWatcherLoop(pollMs: number): Promise<never> {
  for (;;) {
    try {
      await runPaymentWatcherOnce();
    } catch (err) {
      console.error("[payment-watcher] iteration failed", err);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function runActivityFollowerLoop(pollMs: number): Promise<never> {
  for (;;) {
    try {
      await followOnce();
    } catch (err) {
      console.error("[worker] follower iteration failed", err);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function main() {
  await connectToDatabase();
  await recoverInterruptedSessions();
  await recoverInterruptedRecords();
  await recoverStuckDelegationSessions();

  const env = getServerEnv();
  console.log(`[worker] starting chain-activity follower (poll every ${env.ACTIVITY_POLL_MS}ms)`);
  console.log(`[worker] starting payment watcher (poll every ${env.PAYMENT_WATCHER_POLL_MS}ms)`);
  await Promise.all([
    runActivityFollowerLoop(env.ACTIVITY_POLL_MS),
    runPaymentWatcherLoop(env.PAYMENT_WATCHER_POLL_MS),
  ]);
}

main().catch((err) => {
  console.error("[worker] fatal error", err);
  process.exitCode = 1;
});
