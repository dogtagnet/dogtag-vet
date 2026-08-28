import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {ChainActivity} from "@/lib/models/ChainActivity";
import {readIsValidRoot} from "@/lib/chainRead";
import {REASON_CODES} from "@/lib/reasonCodes";
import {badRequest, requireStaffSession} from "@/lib/staffApi";

const REASON_NAMES = new Set<string>(REASON_CODES.map((r) => r.name));

/**
 * `POST /api/tags/revoke-superseded {cloneAddress, dogTagIdField, root, reasonCode, txHash}` -
 * confirms a `revokeTag` transaction for a tag that a REPLACEMENT has already superseded.
 *
 * This is deliberately a separate route from `/api/tags/:petId/lifecycle`, not that same route
 * generalized: `lifecycle` re-reads `pet.dogTag.root` from Mongo as the tag identity to confirm
 * against, which is exactly correct for revoking/reactivating a pet's CURRENT tag but wrong here.
 * By the time the replace wizard's post-bind revoke prompt fires, `POST
 * /api/tags/issue/:sessionId/confirm` has already overwritten that same Pet document's `dogTag`
 * subdocument with the NEW tag's id/root (the data model holds one tag per pet) - so a lookup by
 * `petId` would read back the new tag's state and wrongly refuse to confirm the old tag's
 * revocation (`isValid(newRoot)` is `true`, not `false`). The caller therefore names the
 * SUPERSEDED tag's own `dogTagIdField`/`root` explicitly (captured client-side before the replace
 * flow began), and this route confirms the revoke against exactly that identity - never against
 * whatever a `petId` currently resolves to. No `Pet.dogTag` write happens here for the same
 * reason: that field now correctly describes the replacement tag and this route must not disturb
 * it.
 */
export async function POST(request: Request) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const body = (await request.json().catch(() => null)) as
    | {cloneAddress?: unknown; dogTagIdField?: unknown; root?: unknown; reasonCode?: unknown; txHash?: unknown}
    | null;
  if (typeof body?.cloneAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(body.cloneAddress)) {
    return badRequest("cloneAddress must be a 0x-prefixed 20-byte address.");
  }
  if (typeof body.dogTagIdField !== "string" || !body.dogTagIdField) {
    return badRequest("dogTagIdField is required.");
  }
  if (typeof body.root !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.root)) {
    return badRequest("root must be a 0x-prefixed 32-byte hash.");
  }
  if (typeof body.reasonCode !== "string" || !REASON_NAMES.has(body.reasonCode)) {
    return badRequest("reasonCode must be one of the known reason codes.");
  }
  if (typeof body.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) {
    return badRequest("txHash must be a 0x-prefixed 32-byte transaction hash.");
  }

  await connectToDatabase();

  let valid: boolean;
  try {
    valid = await readIsValidRoot(body.cloneAddress as `0x${string}`, body.root);
  } catch {
    return badRequest("Could not reach the chain to confirm this action.");
  }
  if (valid) {
    return badRequest("The chain does not yet reflect this action. Wait for the transaction to confirm and retry.");
  }

  await ChainActivity.updateOne(
    {id: `${body.txHash}:staff-lifecycle`},
    {
      $setOnInsert: {
        id: `${body.txHash}:staff-lifecycle`,
        type: "TagRevoked",
        blockNumber: 0,
        txHash: body.txHash,
        logIndex: 0,
        blockTimestamp: Math.floor(Date.now() / 1000),
        dogTagId: body.dogTagIdField,
        root: body.root,
        reasonCode: body.reasonCode,
        raw: {source: "staff-lifecycle-route", supersededBy: "replace-wizard"},
      },
    },
    {upsert: true},
  );

  return NextResponse.json({ok: true});
}
