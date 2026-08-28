import "server-only";
import type {Address} from "viem";
import {Payment, type PaymentDoc} from "@/lib/models/Payment";
import {Client, type ClientDoc} from "@/lib/models/Client";
import {PaymentChainCursor} from "@/lib/models/PaymentChainCursor";
import {getClinicSettings, type RpcOverrides} from "@/lib/models/ClinicSettings";
import {getBookingSettings} from "@/lib/models/Availability";
import {getServerEnv} from "@/lib/env";
import {paymentPublicClient} from "@/lib/paymentChainRead";
import {erc20Abi} from "@/lib/abi";
import {ALL_CHAIN_KEYS} from "@/lib/payments/tokenRegistry";
import {matchTransfers, type ObservedTransfer, type OpenRail} from "@/lib/payments/match";
import {markPaymentPaidFromChain, sweepExpiredPayments} from "@/lib/payments/markPaid";
import {sendPaymentPaidEmails} from "@/lib/payments/emails";
import type {PaymentChainKey} from "@/lib/chains";

function requiredConfirmations(chainKey: PaymentChainKey): number {
  const env = getServerEnv();
  return chainKey === "ethereum" || chainKey === "base" ? env.CONFIRMATIONS_MAINNET : env.CONFIRMATIONS_TESTNET;
}

/**
 * Native-asset (ETH) transfers emit no logs, so - unlike the ERC-20 branch below, which is one
 * `getContractEvents` call regardless of range - detecting them means fetching each block's full
 * transaction list and filtering by `to`. This is materially heavier per block than a log query,
 * which is exactly why it only ever runs for a chain that currently has at least one OPEN
 * native-ETH rail (`nativeAddresses` empty => this function is never called), and only over the
 * small range this scan iteration actually needs. It also only sees top-level transactions - a
 * native transfer made via an internal contract call (a multisig, a relayer contract) is invisible
 * to this scan, a real limitation acceptable at the invoice volumes this template targets.
 */
async function scanNativeTransfers(
  client: ReturnType<typeof paymentPublicClient>,
  fromBlock: bigint,
  toBlock: bigint,
  nativeAddresses: Set<string>,
): Promise<ObservedTransfer[]> {
  const transfers: ObservedTransfer[] = [];
  for (let b = fromBlock; b <= toBlock; b++) {
    const block = await client.getBlock({blockNumber: b, includeTransactions: true});
    for (const tx of block.transactions) {
      if (typeof tx === "string") continue; // includeTransactions:true always expands them; guard for the type
      if (!tx.to || !nativeAddresses.has(tx.to.toLowerCase())) continue;
      transfers.push({
        to: tx.to,
        tokenAddress: undefined,
        amountBase: tx.value.toString(),
        blockNumber: Number(b),
        txHash: tx.hash,
        from: tx.from,
      });
    }
  }
  return transfers;
}

async function scanErc20Transfers(
  client: ReturnType<typeof paymentPublicClient>,
  fromBlock: bigint,
  toBlock: bigint,
  tokenAddresses: string[],
  receivingAddresses: string[],
): Promise<ObservedTransfer[]> {
  if (tokenAddresses.length === 0) return [];
  const logs = await client.getContractEvents({
    address: tokenAddresses as Address[],
    abi: erc20Abi,
    eventName: "Transfer",
    args: {to: receivingAddresses as Address[]},
    fromBlock,
    toBlock,
  });
  return logs.map((log) => {
    const args = log.args as {from?: Address; to?: Address; value?: bigint};
    return {
      to: (args.to ?? "").toString(),
      tokenAddress: log.address,
      amountBase: (args.value ?? 0n).toString(),
      blockNumber: Number(log.blockNumber),
      txHash: log.transactionHash!,
      from: (args.from ?? "").toString(),
    };
  });
}

async function scanChain(chainKey: PaymentChainKey, rails: OpenRail[], rpcOverrides: RpcOverrides): Promise<void> {
  const client = paymentPublicClient(chainKey, rpcOverrides);
  const latest = await client.getBlockNumber();
  const confirmations = requiredConfirmations(chainKey);

  const cursorDoc = await PaymentChainCursor.findById(chainKey).lean<{blockNumber: number}>();
  // First-ever observation of this chain skips straight to the tip rather than scanning history:
  // a payment chain like Ethereum mainnet cannot afford a genesis scan the way the dedicated,
  // low-volume ROAX activity follower can - see src/worker/index.ts's doc comment for that
  // contrast. Any payment created before the watcher first ran on this chain simply relies on
  // staff being able to manually mark it paid instead.
  const fromBlock = cursorDoc ? BigInt(cursorDoc.blockNumber) + 1n : latest;
  const safeTip = latest > BigInt(confirmations) ? latest - BigInt(confirmations) : 0n;
  if (fromBlock > latest) {
    await PaymentChainCursor.updateOne({_id: chainKey}, {$set: {blockNumber: Number(safeTip)}}, {upsert: true});
    return;
  }

  const env = getServerEnv();
  const chunk = BigInt(env.PAYMENT_ACTIVITY_CHUNK_BLOCKS);
  const toBlock = fromBlock + chunk - 1n > latest ? latest : fromBlock + chunk - 1n;

  const erc20Rails = rails.filter((r) => r.tokenAddress !== undefined);
  const nativeRails = rails.filter((r) => r.tokenAddress === undefined);
  const tokenAddresses = Array.from(new Set(erc20Rails.map((r) => r.tokenAddress!)));
  const erc20ReceivingAddresses = Array.from(new Set(erc20Rails.map((r) => r.receivingAddress)));
  const nativeAddresses = new Set(nativeRails.map((r) => r.receivingAddress.toLowerCase()));

  const [erc20Transfers, nativeTransfers] = await Promise.all([
    scanErc20Transfers(client, fromBlock, toBlock, tokenAddresses, erc20ReceivingAddresses),
    nativeAddresses.size > 0 ? scanNativeTransfers(client, fromBlock, toBlock, nativeAddresses) : Promise.resolve([]),
  ]);

  const matches = matchTransfers([...erc20Transfers, ...nativeTransfers], rails, Number(latest), confirmations);

  for (const match of matches) {
    const updated = await markPaymentPaidFromChain(match.paymentId, {
      chainKey: match.chainKey,
      token: match.token,
      txHash: match.transfer.txHash,
      from: match.transfer.from,
      amountBase: match.transfer.amountBase,
      blockNumber: match.transfer.blockNumber,
      confirmedAt: new Date(),
    });
    if (!updated) continue; // already settled by a concurrent path (manual mark-paid, another tick)
    const [settings, bookingSettings, clientDoc] = await Promise.all([
      getClinicSettings(),
      getBookingSettings(),
      updated.clientId ? Client.findOne({clientId: updated.clientId}).lean<ClientDoc>() : Promise.resolve(null),
    ]);
    // Best-effort, same reasoning as the manual mark-paid route: the payment is already durably
    // paid on chain, so a notification failure must never abort this scan iteration - that would
    // leave the cursor unadvanced and later matches in this same range unprocessed until the next
    // tick re-derives them, for no benefit (the paid status itself is not at risk).
    try {
      await sendPaymentPaidEmails(
        updated,
        settings.businessProfile,
        clientDoc ? {name: clientDoc.name, email: clientDoc.email} : undefined,
        bookingSettings.timezone,
      );
    } catch (err) {
      console.error(`[watcher] payment ${updated.paymentId} marked paid but notification email failed:`, err);
    }
  }

  // Only advance the persisted cursor to the safe (confirmed) tip, never past it - a block within
  // the confirmation window is deliberately re-scanned on the next tick until it matures, per
  // match.ts's doc comment on why the matcher itself, not cursor placement, is what enforces the
  // confirmation threshold.
  const newCursor = toBlock < safeTip ? toBlock : safeTip;
  if (newCursor >= fromBlock - 1n) {
    await PaymentChainCursor.updateOne({_id: chainKey}, {$set: {blockNumber: Number(newCursor)}}, {upsert: true});
  }
}

/** One tick of the payment watcher: expiry sweep, then a scan of every payment chain that
 * currently has at least one open (`pending`) crypto rail. Called on its own `setInterval` in
 * `src/worker/index.ts`, independent of that file's pre-existing chain-activity follower loop. */
export async function runPaymentWatcherOnce(): Promise<void> {
  await sweepExpiredPayments(Math.floor(Date.now() / 1000));

  const openPayments = await Payment.find({status: "pending"}).lean<PaymentDoc[]>();
  if (openPayments.length === 0) return;

  const settings = await getClinicSettings();
  const openRails: OpenRail[] = openPayments.flatMap((p) =>
    p.crypto.map((c) => ({
      paymentId: p.paymentId,
      chainKey: c.chainKey,
      token: c.token,
      tokenAddress: c.tokenAddress,
      receivingAddress: c.receivingAddress,
      amountBase: c.amountBase,
    })),
  );

  for (const chainKey of ALL_CHAIN_KEYS) {
    const rails = openRails.filter((r) => r.chainKey === chainKey);
    if (rails.length === 0) continue;
    try {
      await scanChain(chainKey, rails, settings.rpcOverrides);
    } catch (err) {
      console.error(`[payment-watcher] scan failed for ${chainKey}`, err);
    }
  }
}
