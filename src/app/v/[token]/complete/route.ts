import {connectToDatabase} from "@/lib/db";
import {RecordVerifySession, type RecordVerifySessionDoc, type RecordVerifyStoredResult} from "@/lib/models/RecordVerifySession";
import {recordArtifactWireSchema} from "@/lib/schemas/recordArtifactWire";
import {verifyPresentedRecordArtifact, type RecordVerifyStage} from "@/lib/records/verifier";
import {readIsValidRoot, readIssuedBy, readRecordTypeOf, readRootIssuer} from "@/lib/chainRead";
import {requireEnv} from "@/lib/env";
import {roax} from "@/lib/chains";
import {hexToken32} from "@/lib/schemas/common";
import {enforceRateLimit, errorBody, jsonWithHeaders} from "@/lib/publicApi";

function toStoredResult(stage: RecordVerifyStage): RecordVerifyStoredResult {
  switch (stage.stage) {
    case "crypto_failed":
    case "chain_unreadable":
    case "wrong_chain":
      return {stage: stage.stage};
    case "not_anchored":
      return {stage: "not_anchored", reason: stage.reason};
    case "verified":
      return {stage: "verified", issuerClone: stage.issuerClone, recordType: stage.recordType, validity: stage.validity};
  }
}

/**
 * `POST /v/:token/complete` - plan section 11.2 V6, the ceremony's consuming step: the owner's
 * device posts `{artifact: <RecordArtifact JSON>}` (whatever it chose to present, masked or not -
 * staff never picks a specific record in advance, see `.../start/route.ts`'s own doc comment).
 *
 * One-shot on EVERY outcome from the atomic consume onward, success or refusal alike (mirrors
 * `POST /w/:token/complete`'s own "a burned token is simply dead" rule) - via the identical
 * `findOneAndUpdate` unset-to-set race-resolution every other ceremony's `tryConsume` uses, so two
 * concurrent posts of the same token can never both win.
 *
 * NOT one-shot before that point: an unparseable token (404) or a body that fails
 * `recordArtifactWireSchema` (400, "malformed_artifact") returns BEFORE the token is looked up /
 * consumed at all, so the token is still live and `GET /v/:token` still reports "pending" - a
 * confused or buggy phone client gets to retry with a corrected body. This is a deliberate,
 * narrow allowance: the rate limiter above (30/min per IP) is the only thing bounding
 * malformed-body retries, since they never touch the chain-read pipeline below. Once a body
 * parses as a shape-valid `RecordArtifact` the token IS burned by the following
 * `findOneAndUpdate`, even if the artifact then fails verification (crypto_failed / chain
 * checks) - a wrong-but-well-formed presentment counts as "presented," matching how a human
 * ceremony works (you showed staff something, right or wrong; you don't get to silently retry
 * with a different document under the same QR).
 *
 * The verification pipeline (`lib/records/verifier.ts`) runs against THIS deployment's own
 * configured factory/chain - never trusting the artifact's own claimed issuer without cross-checking
 * it, exactly the on-chain binding rules `specs/leaf-commitment.md` section 16 state.
 *
 * The stored result keeps `disclosedKeyPaths` (an array of keyPath strings) only - never the leaf
 * *values* - even though this endpoint is unauthenticated and the resulting `RecordVerifySession`
 * document is later polled by any staff member. Storing values would put a stranger's pet/medical
 * data in the vet's own database off the back of an anonymous POST; storing only which fields were
 * disclosed is enough for the staff-facing panel to label what it's looking at without retaining
 * the content itself.
 */
export async function POST(request: Request, {params}: {params: Promise<{token: string}>}) {
  const rateLimit = enforceRateLimit(request, "record-verify-complete", 30, 60_000);
  if (rateLimit.limited) return rateLimit.response;

  const {token: rawToken} = await params;
  const parsedToken = hexToken32.safeParse(rawToken);
  if (!parsedToken.success) {
    return jsonWithHeaders(errorBody("not_found", "Token unknown or malformed."), {status: 404, headers: rateLimit.headers});
  }

  const body = await request.json().catch(() => null);
  const parsedArtifact = recordArtifactWireSchema.safeParse((body as {artifact?: unknown} | null)?.artifact);
  if (!parsedArtifact.success) {
    return jsonWithHeaders(
      errorBody("malformed_artifact", "This does not look like a RecordArtifact.", parsedArtifact.error.flatten()),
      {status: 400, headers: rateLimit.headers},
    );
  }

  await connectToDatabase();
  const now = Math.floor(Date.now() / 1000);
  const session = await RecordVerifySession.findOne({token: parsedToken.data}).lean<RecordVerifySessionDoc>();
  if (!session) {
    return jsonWithHeaders(errorBody("not_found", "Token unknown or malformed."), {status: 404, headers: rateLimit.headers});
  }
  if (session.status !== "pending" || now > session.exp) {
    return jsonWithHeaders(errorBody("expired_or_reused", "This verification request has expired or was already used."), {
      status: 410,
      headers: rateLimit.headers,
    });
  }

  const consumed = await RecordVerifySession.findOneAndUpdate(
    {token: parsedToken.data, status: "pending"},
    {$set: {status: "presented", presentedAt: now}},
  ).lean<RecordVerifySessionDoc>();
  if (!consumed) {
    return jsonWithHeaders(errorBody("expired_or_reused", "This verification request has expired or was already used."), {
      status: 410,
      headers: rateLimit.headers,
    });
  }

  let factoryAddress: `0x${string}`;
  try {
    factoryAddress = requireEnv("VET_ISSUER_FACTORY_ADDRESS") as `0x${string}`;
  } catch {
    const result: RecordVerifyStoredResult = {stage: "chain_unreadable"};
    await RecordVerifySession.updateOne({token: parsedToken.data}, {$set: {result}});
    return jsonWithHeaders({result}, {headers: rateLimit.headers});
  }

  const stage = await verifyPresentedRecordArtifact(
    parsedArtifact.data,
    {
      readRootIssuer: (root) => readRootIssuer(factoryAddress, root as `0x${string}`),
      readRecordTypeOf: (cloneAddress, root) => readRecordTypeOf(cloneAddress as `0x${string}`, root as `0x${string}`),
      readIsValidRoot: (cloneAddress, root) => readIsValidRoot(cloneAddress as `0x${string}`, root as `0x${string}`),
      readIssuedBy: (cloneAddress, root) => readIssuedBy(cloneAddress as `0x${string}`, root as `0x${string}`),
    },
    roax.id,
  );

  const result = toStoredResult(stage);
  result.disclosedKeyPaths = parsedArtifact.data.disclosed.map((l) => l.keyPath);
  await RecordVerifySession.updateOne({token: parsedToken.data}, {$set: {result}});

  return jsonWithHeaders({result}, {headers: rateLimit.headers});
}
