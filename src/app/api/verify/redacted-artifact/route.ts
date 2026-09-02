import type {Address} from "viem";
import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {redactedTagArtifactSchema} from "@/lib/schemas/redactedArtifact";
import {verifyRedactedArtifactSubmission} from "@/lib/tags/verifyRedactedFlow";
import {mongoMobileTagChainDeps, unconfiguredMobileTagChainDeps} from "@/lib/booking/mobileMongoAdapters";
import {getServerEnv} from "@/lib/env";
import {badRequest, requireStaffSession} from "@/lib/staffApi";

/**
 * `POST /api/verify/redacted-artifact` - WP4.10V item 5's "Verify a redacted artifact" staff page.
 * Staff-only. Accepts the pasted/uploaded `RedactedTagArtifact` JSON directly as the request body
 * (no envelope) - registry-first shape validation (`redactedTagArtifactSchema`), then the pipeline
 * `lib/tags/verifyRedactedFlow.ts`'s own doc comment describes in full: `verifyRedactedArtifact`,
 * then chain binding via the SAME shared verifier the WP4.4 booking path and the WP4.9 import
 * ceremony already use (`resolveTagRootAndIssuer`/`readIsValidRoot`, `lib/tags/verifier.ts`).
 *
 * Reuses `lib/booking/mobileMongoAdapters.ts`'s `mongoMobileTagChainDeps`/
 * `unconfiguredMobileTagChainDeps` verbatim (the SAME `TagDataChainDeps` shape the WP4.4/WP4.9
 * paths already configure identically) - unlike `/i/:token/complete`, this route does not also
 * gate on `settings?.cloneAddress`: verifying an arbitrary pasted artifact never needs to know
 * whether THIS clinic's own clone is configured (that only matters for a "reclaim" determination,
 * which this read-only verification never makes).
 */
export async function POST(request: Request) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const body = await request.json().catch(() => null);
  const parsed = redactedTagArtifactSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest("This does not look like a RedactedTagArtifact.", parsed.error.flatten());
  }

  await connectToDatabase();
  const env = getServerEnv();
  const chainDeps =
    env.DOGTAG_SBT_ADDRESS && env.VET_ISSUER_FACTORY_ADDRESS
      ? mongoMobileTagChainDeps(env.DOGTAG_SBT_ADDRESS as Address, env.VET_ISSUER_FACTORY_ADDRESS as Address)
      : unconfiguredMobileTagChainDeps();

  const result = await verifyRedactedArtifactSubmission(parsed.data, chainDeps);

  return NextResponse.json({
    result,
    // Display context the UI needs for "which fields are masked" - already fully known from the
    // parsed artifact itself, never something the verification pipeline needs to compute or thread
    // through a second time (see verifyRedactedFlow.ts's own doc comment on why).
    disclosedKeyPaths: parsed.data.disclosed.map((d) => d.keyPath),
    obfuscatedCount: parsed.data.obfuscatedLeafHashes.length,
    reservedCount: parsed.data.reservedLeafHashes.length,
  });
}
