import "server-only";
import {ArtifactExportSession} from "@/lib/models/ArtifactExportSession";

/**
 * `GET /e/:token`'s ONE dispatch read (plan section 11.2 V5) - which sibling ceremony
 * (`lib/tags/exportFlow.ts` vs `lib/records/exportFlow.ts`) actually owns this token, decided
 * BEFORE either ceremony's own (consuming) logic ever runs. A read-only peek - never consumes,
 * never mutates - so calling it costs nothing beyond one extra indexed `findOne` per `/e/:token`
 * hit; deliberately NOT folded into either flow's own `getByToken` (which would mean threading a
 * pre-fetched session into `resolveAndConsumeExport`, the one function the plan's own non-negotiable
 * requires to stay byte-identical/untouched for the tag path).
 *
 * Returns `"tag"` for a session that does not exist at all, alongside every genuine tag session
 * (`artifactType` absent) and even one somehow missing `artifactType` incorrectly - safe by
 * construction either way: the route always calls `resolveAndConsumeExport` (tag) next on that
 * branch, whose OWN not-found handling produces the identical `{ok:false, code:"not_found"}` a
 * record-flow "not found" would have produced too. This function's only real job is steering a
 * GENUINE record token to the record flow; every other case degrades harmlessly to the pre-existing
 * tag path.
 */
export async function peekExportSessionArtifactType(token: string): Promise<"tag" | "record"> {
  const doc = await ArtifactExportSession.findOne({token}).select("artifactType").lean<{artifactType?: "tag" | "record"}>();
  return doc?.artifactType === "record" ? "record" : "tag";
}
