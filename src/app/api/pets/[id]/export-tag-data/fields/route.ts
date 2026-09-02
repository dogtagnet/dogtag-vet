import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {findActiveTagArtifact} from "@/lib/tags/artifact";
import {listExportableFields} from "@/lib/tags/exportFlow";
import {notFound, requireStaffSession} from "@/lib/staffApi";

/**
 * `GET /api/pets/:id/export-tag-data/fields` - WP4.10V item 4's field-picker data source. Staff-
 * only, read-only (no session created, no token minted). Lists every leaf on the pet's ACTIVE
 * artifact this clinic currently holds an opening for, each with its keyPath, value, display
 * GROUP ("pet" vs "owner_identity"), and its precomputed `leafHash` (what it would become in
 * `obfuscatedLeafHashes` if staff picks it to mask - `lib/tags/exportFlow.ts`'s `recomputeLeafHash`,
 * the SAME function `resolveAndConsumeExport` itself uses, never a second copy).
 *
 * Hashing happens HERE, server-side, deliberately - so the "use client" field-picker component
 * never imports `@dogtag/standard` (this repo's own `serverExternalPackages`/cold-client-build
 * hazard for the poseidon/circomlibjs dependency chain - `e2e/tag-custody.spec.ts`'s own doc
 * comment names the precedent incident). The picker's live preview is then a pure client-side
 * value-to-`leafHash` swap for whichever keyPaths are checked - no crypto in the browser.
 *
 * `reservedCount` is always 3 today (`TagArtifactDoc.reservedLeafHashes`'s own invariant) - surfaced
 * so the picker can render "N reserved owner-control values - always kept private" without the
 * client needing to know that number is a protocol constant.
 *
 * `alreadyMaskedCount` (WP4.10V item 6) - leaves this artifact ITSELF already only holds a hash
 * for (partial custody from an earlier masked import). These can never appear in `fields` at all:
 * there is no opening to list a keyPath/value/leafHash from, only the opaque hash already in
 * `obfuscatedLeafHashes` - the picker can offer to mask what it holds, never to UNMASK what it
 * never received. Surfaced as a count (never a keyPath - this clinic genuinely does not know
 * which fields these were) so the picker can say so explicitly rather than the absence being
 * silent.
 */
export async function GET(_request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id: petId} = await params;
  await connectToDatabase();
  const artifact = await findActiveTagArtifact(petId);
  if (!artifact) return notFound("This pet has no tag data on file yet - issue or import a tag first.");

  return NextResponse.json({
    fields: listExportableFields(artifact.leaves),
    reservedCount: artifact.reservedLeafHashes.length,
    alreadyMaskedCount: artifact.obfuscatedLeafHashes?.length ?? 0,
  });
}
