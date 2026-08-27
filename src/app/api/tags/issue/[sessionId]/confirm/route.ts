import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {MintSession, type MintSessionDoc} from "@/lib/models/MintSession";
import {Pet} from "@/lib/models/Pet";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {requireEnv} from "@/lib/env";
import {readIsValidRoot, readProfileRoot} from "@/lib/chainRead";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";

/**
 * `POST /api/tags/issue/:sessionId/confirm` - wp4-vet.md issuance step 5: "the worker (or a
 * server poll) confirms the receipt AND reads back `profileRoot(id) == root` and `isValid(root)`
 * before setting `bound` (a receipt is not proof)". The staff UI calls this right after `wagmi`'s
 * `waitForTransactionReceipt` resolves for the `issueTag` tx - a confirmed receipt on its own is
 * not treated as sufficient; both chain reads below must independently agree.
 */
export async function POST(request: Request, {params}: {params: Promise<{sessionId: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {sessionId} = await params;
  await connectToDatabase();
  const session = await MintSession.findOne({sessionId}).lean<MintSessionDoc>();
  if (!session) return notFound("Mint session not found.");
  if (session.status !== "issuing" || !session.root) {
    return badRequest("Only an issuing session with a sealed root can be confirmed.");
  }

  const settings = await getClinicSettings();
  if (!settings.cloneAddress) return badRequest("This clinic has not completed setup.");

  let onChainRoot: string;
  let valid: boolean;
  try {
    const sbtAddress = requireEnv("DOGTAG_SBT_ADDRESS") as `0x${string}`;
    onChainRoot = await readProfileRoot(sbtAddress, session.dogTagIdField);
    valid = await readIsValidRoot(settings.cloneAddress as `0x${string}`, session.root);
  } catch {
    // A transient read failure is neither confirmed nor refused permanently - leave the session
    // `issuing` so the staff UI can simply retry the confirm call, rather than burning the tag
    // into `error` over a flaky RPC call.
    return NextResponse.json({sessionId, status: "issuing", confirmed: false}, {status: 202});
  }

  if (onChainRoot.toLowerCase() !== session.root.toLowerCase() || !valid) {
    await MintSession.updateOne({sessionId}, {$set: {status: "error", errorStage: "verify"}});
    return badRequest("On-chain confirmation did not match. The tag was not marked bound.");
  }

  await MintSession.updateOne({sessionId}, {$set: {status: "bound", resolvedAt: new Date()}});
  if (session.petId) {
    await Pet.updateOne(
      {petId: session.petId},
      {
        $set: {
          "dogTag.dogTagIdDec": session.dogTagIdDec,
          "dogTag.dogTagIdField": session.dogTagIdField,
          "dogTag.root": session.root,
          "dogTag.status": "active",
          "dogTag.issuedTx": session.txHash,
          "dogTag.cloneAddress": settings.cloneAddress,
        },
      },
    );
  }

  return NextResponse.json({sessionId, status: "bound", dogTagId: session.dogTagIdDec, root: session.root});
}
