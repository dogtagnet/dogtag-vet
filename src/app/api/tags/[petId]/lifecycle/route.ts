import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {ChainActivity} from "@/lib/models/ChainActivity";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {readIsValidRoot} from "@/lib/chainRead";
import {REASON_CODES, type ReasonCodeName} from "@/lib/reasonCodes";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";

const REASON_NAMES = new Set<string>(REASON_CODES.map((r) => r.name));

/**
 * `POST /api/tags/:petId/lifecycle {action, reasonCode, txHash}` - records the outcome of a
 * `revokeTag`/`reactivateTag` transaction the staff wallet already sent and confirmed (wagmi,
 * browser-side; no server-held key ever signs this). The clone's own event log is the real
 * source of truth (the chain-activity worker reconciles from it independently) - this route just
 * keeps the Pets/Tags UI from waiting on the next worker poll to reflect a status change the
 * staff member is looking at right now, and re-reads `isValid(root)` itself before trusting the
 * tx rather than assuming the requested action is what actually happened on chain.
 */
export async function POST(request: Request, {params}: {params: Promise<{petId: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {petId} = await params;
  const body = (await request.json().catch(() => null)) as
    | {action?: unknown; reasonCode?: unknown; txHash?: unknown}
    | null;
  if (body?.action !== "revoke" && body?.action !== "reactivate") {
    return badRequest("action must be 'revoke' or 'reactivate'.");
  }
  if (typeof body.reasonCode !== "string" || !REASON_NAMES.has(body.reasonCode)) {
    return badRequest("reasonCode must be one of the known reason codes.");
  }
  if (typeof body.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) {
    return badRequest("txHash must be a 0x-prefixed 32-byte transaction hash.");
  }

  await connectToDatabase();
  const pet = await Pet.findOne({petId}).lean<PetDoc>();
  if (!pet || !pet.dogTag.root) return notFound("Tag not found for this pet.");

  const settings = await getClinicSettings();
  if (!settings.cloneAddress) return badRequest("This clinic has not completed setup.");

  let valid: boolean;
  try {
    valid = await readIsValidRoot(settings.cloneAddress as `0x${string}`, pet.dogTag.root);
  } catch {
    return badRequest("Could not reach the chain to confirm this action.");
  }
  const expectedValid = body.action === "reactivate";
  if (valid !== expectedValid) {
    return badRequest("The chain does not yet reflect this action. Wait for the transaction to confirm and retry.");
  }

  const newStatus = body.action === "revoke" ? "revoked" : "active";
  await Pet.updateOne({petId}, {$set: {"dogTag.status": newStatus}});
  await ChainActivity.updateOne(
    {id: `${body.txHash}:staff-lifecycle`},
    {
      $setOnInsert: {
        id: `${body.txHash}:staff-lifecycle`,
        type: body.action === "revoke" ? "TagRevoked" : "TagReactivated",
        blockNumber: 0,
        txHash: body.txHash,
        logIndex: 0,
        blockTimestamp: Math.floor(Date.now() / 1000),
        dogTagId: pet.dogTag.dogTagIdField,
        root: pet.dogTag.root,
        reasonCode: body.reasonCode as ReasonCodeName,
        raw: {source: "staff-lifecycle-route"},
      },
    },
    {upsert: true},
  );

  return NextResponse.json({petId, status: newStatus});
}
