import {connectToDatabase} from "@/lib/db";
import {getDelegationSessionStatusForDevice} from "@/lib/delegation/flow";
import {mongoDelegationStore} from "@/lib/delegation/mongoStore";
import {buildDelegationCoOwnerBundle, type DelegationCoOwnerBundle} from "@/lib/delegation/bundle";
import {findActiveTagArtifact} from "@/lib/tags/artifact";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {roax} from "@/lib/chains";
import {readDelegationLeaves} from "@/lib/chainRead";
import {hexToken32} from "@/lib/schemas/common";
import {enforceRateLimit, errorBody, jsonWithHeaders} from "@/lib/publicApi";
import {requireEnv} from "@/lib/env";

/**
 * `GET /d/:token/status` - `specs/vet-public-api.yaml`'s `getDelegationSessionStatus`, add-kind
 * only (`getDelegationSessionStatusForDevice` scopes the lookup the same way `GET /d/:token`
 * does). `status` here is the PUBLIC wire vocabulary `[pending, claimed, adding, added, error]` -
 * this route is the ONE place this app's internal `"submitting"/"confirmed"` ever get translated
 * to the wire's `"adding"/"added"` (`lib/delegation/flow.ts`'s own doc comment on why the
 * translation lives here and not on the stored document).
 *
 * `bundle` (V4, `DelegationCoOwnerBundle`) is attached whenever `readyForBundle` is true - on
 * EVERY such poll within the grace window, exactly what the spec's "once (and only once) it
 * reports added" asks for ("once" reads as "when", not a delivery count - see
 * `getDelegationSessionStatusForDevice`'s own doc comment for the full reasoning; there is no
 * behavior to change here, only prose that used to describe this as a deviation). Built from the
 * pet's currently-ACTIVE `TagArtifact` (this clinic's own custody record, the same one `/e/:token`
 * exports through) plus a LIVE `delegationLeaves` chain read - never reconstructed from anything
 * this app stores, per `specs/vet-public-api.yaml`'s own warning that folding fewer than 16 values
 * produces a different tree than the one `delegationRoot` actually commits to.
 *
 * `bundleUnavailable` (grade round 1 D3): a bundle was expected (`readyForBundle` was true) but
 * could not be built just now - vet-side-additive, not yet in the vendored spec (which this repo
 * cannot edit; it lives in the protocol repo). Before this field existed, that case was
 * INDISTINGUISHABLE on the wire from "not ready yet": `tryBuildBundle` caught every error and
 * returned `undefined` exactly the same way a not-yet-ready poll does, so a real fault (a missing
 * `TagArtifact`, an unreadable chain, a self-check failure) was silent in production - the device
 * would just keep seeing a bare `{"status":"added"}` forever with no signal anything was wrong.
 * Every non-success path here also `console.error`s with enough detail to actually debug it.
 */
export async function GET(request: Request, {params}: {params: Promise<{token: string}>}) {
  const rateLimit = enforceRateLimit(request, "delegation-status", 60, 60_000);
  if (rateLimit.limited) return rateLimit.response;

  const {token: rawToken} = await params;
  const parsedToken = hexToken32.safeParse(rawToken);
  if (!parsedToken.success) {
    return jsonWithHeaders(errorBody("not_found", "Token unknown or malformed."), {status: 404, headers: rateLimit.headers});
  }

  await connectToDatabase();
  const now = Math.floor(Date.now() / 1000);
  const result = await getDelegationSessionStatusForDevice(mongoDelegationStore, parsedToken.data, now);
  if (!result.ok) {
    const message = result.status === 404 ? "Token unknown or malformed." : "This session is no longer available.";
    const code = result.status === 404 ? "not_found" : "expired_or_reused";
    return jsonWithHeaders(errorBody(code, message), {status: result.status, headers: rateLimit.headers});
  }

  let bundleAttempt: BundleAttempt = {};
  if (result.readyForBundle) {
    bundleAttempt = await tryBuildBundle(result.session);
  }

  return jsonWithHeaders(
    {
      status: result.status,
      dogTagIdField: result.dogTagIdField,
      ...(result.reason ? {reason: result.reason} : {}),
      ...(bundleAttempt.bundle ? {bundle: bundleAttempt.bundle} : {}),
      ...(bundleAttempt.bundleUnavailable ? {bundleUnavailable: true as const} : {}),
    },
    {headers: rateLimit.headers},
  );
}

interface BundleAttempt {
  bundle?: DelegationCoOwnerBundle;
  /** See this file's own top doc comment (grade round 1 D3). Set on every path that does not
   * produce a `bundle` - a missing `TagArtifact`, `buildDelegationCoOwnerBundle`'s own self-check
   * failing, or any thrown error (an unreadable chain, a missing env var). */
  bundleUnavailable?: true;
}

async function tryBuildBundle(session: {
  petId: string;
  dogTagIdField: string;
  clinicName: string;
}): Promise<BundleAttempt> {
  try {
    const delegationRegistryAddress = requireEnv("DELEGATION_REGISTRY_ADDRESS") as `0x${string}`;
    const [artifact, pet, leaves] = await Promise.all([
      findActiveTagArtifact(session.petId),
      Pet.findOne({petId: session.petId}).select("name").lean<Pick<PetDoc, "name">>(),
      readDelegationLeaves(delegationRegistryAddress, session.dogTagIdField),
    ]);
    if (!artifact) {
      console.error(`[delegation] no active TagArtifact for pet ${session.petId} while building its co-owner bundle - this tag predates WP4.9 custody records (or was never issued through this clinic) and needs a backfill before a bundle can ever be built for it`);
      return {bundleUnavailable: true};
    }
    const built = buildDelegationCoOwnerBundle(
      // `.lean()` never applies a schema default - a row written before `obfuscatedLeafHashes`
      // existed reads back with the key genuinely absent, normalized here the same way
      // `exportMongoAdapter.ts` does for the identical field on the identical model.
      {...artifact, obfuscatedLeafHashes: artifact.obfuscatedLeafHashes ?? []},
      {delegationLeaves: leaves, chainId: roax.id, petName: pet?.name ?? "", clinicName: session.clinicName},
    );
    if (!built.ok) {
      console.error(`[delegation] buildDelegationCoOwnerBundle's own self-check failed for pet ${session.petId} - the artifact's disclosed/obfuscated data did not recompute to its own root`);
      return {bundleUnavailable: true};
    }
    return {bundle: built.bundle};
  } catch (err) {
    // The bundle is additive - a failure to build it here must never turn an otherwise-successful
    // "added" status poll into an error response; the device simply polls again (now with
    // `bundleUnavailable` telling it plainly that this poll's attempt did not work, rather than
    // looking identical to "not ready yet"), and this app's own boot-recovery/confirm route already
    // made the on-chain state true regardless of whether this particular read of it happened to
    // succeed.
    console.error("[delegation] failed to build the co-owner bundle for a confirmed session", err);
    return {bundleUnavailable: true};
  }
}
