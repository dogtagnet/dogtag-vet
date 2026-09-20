import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {DelegationSession, type DelegationSessionDoc} from "@/lib/models/DelegationSession";
import {reconcileDelegationWrite} from "@/lib/delegation/reconcile";
import {readDelegationRoot, readIsSecondary, readSecondaryCount, readTxReceiptStatus} from "@/lib/chainRead";
import {badRequest, notFound, requireVetSession} from "@/lib/staffApi";
import {requireEnv} from "@/lib/env";

/**
 * `POST /api/pets/:id/delegations/:registrationId/confirm` - the staff UI calls this right after
 * `wagmi`'s `useWaitForTransactionReceipt` resolves for the `addSecondaryOwner`/
 * `revokeSecondaryOwner` tx, mirroring `POST /api/tags/issue/:sessionId/confirm` exactly: a
 * confirmed receipt on its own is not treated as sufficient, `reconcileDelegationWrite`'s
 * `isSecondary` chain re-read is the decisive check (see that module's own doc comment on why).
 *
 * Idempotent (a repeat call on an already-`confirmed` session simply reports what is already
 * true) and tolerant the same way the mint confirm route is: callable from `"submitting"` OR
 * `"error"` (a prior confirm attempt that came back inconclusive or reverted does not permanently
 * block a later one from discovering the write actually did land - a live chain read always wins
 * over a stale local guess).
 */
export async function POST(request: Request, {params}: {params: Promise<{id: string; registrationId: string}>}) {
  const {response} = await requireVetSession();
  if (response) return response;

  const {id, registrationId} = await params;
  await connectToDatabase();
  const session = await DelegationSession.findOne({registrationId}).lean<DelegationSessionDoc>();
  if (!session || session.petId !== id) return notFound("Delegation session not found.");

  if (session.status === "confirmed") {
    return NextResponse.json({registrationId, status: "confirmed", commitment: session.commitment});
  }
  if (!session.commitment || !session.txHash || (session.status !== "submitting" && session.status !== "error")) {
    return badRequest("Only a submitted session with a recorded commitment and transaction can be confirmed.");
  }

  let delegationRegistryAddress: `0x${string}`;
  try {
    delegationRegistryAddress = requireEnv("DELEGATION_REGISTRY_ADDRESS") as `0x${string}`;
  } catch {
    return badRequest("This clinic has not completed setup for multi-owner tags.");
  }

  const outcome = await reconcileDelegationWrite(
    {kind: session.kind, dogTagIdField: session.dogTagIdField, commitment: session.commitment, txHash: session.txHash},
    {
      isSecondary: (dogTagIdField, commitment) => readIsSecondary(delegationRegistryAddress, dogTagIdField, commitment as `0x${string}`),
      secondaryCount: (dogTagIdField) => readSecondaryCount(delegationRegistryAddress, dogTagIdField),
      delegationRoot: (dogTagIdField) => readDelegationRoot(delegationRegistryAddress, dogTagIdField),
      txReceiptStatus: (txHash) => readTxReceiptStatus(txHash as `0x${string}`),
    },
  );

  if (outcome.reconciled) {
    await DelegationSession.updateOne(
      {registrationId, status: {$ne: "confirmed"}},
      {$set: {status: "confirmed", secondaryCountAtConfirm: outcome.secondaryCount, delegationRootAtConfirm: outcome.delegationRoot}, $unset: {errorReason: ""}},
    );
    return NextResponse.json({registrationId, status: "confirmed", commitment: session.commitment});
  }

  if (outcome.reason === "reverted") {
    if (session.status === "submitting") {
      await DelegationSession.updateOne(
        {registrationId, status: "submitting"},
        {$set: {status: "error", errorReason: "Transaction reverted on chain - start a new ceremony."}},
      );
    }
    return badRequest("The on-chain transaction reverted. Start a new ceremony to try again.");
  }

  // "chain-read-failed" or "not-yet": neither confirmed nor refused permanently - leave the
  // session exactly as it was so the staff UI can simply retry the confirm call, rather than
  // burning it into "error" over a flaky RPC call or a transaction still awaiting confirmation.
  return NextResponse.json({registrationId, status: session.status, confirmed: false}, {status: 202});
}
