import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {MintSession, type MintSessionDoc} from "@/lib/models/MintSession";
import {requireStaffSession} from "@/lib/staffApi";

/** `GET /api/tags` - the `/tags` page's DataTable feed: every pet with an issued tag, plus every
 * mint session still in flight (pending/ready/issuing) or needing a retry (error).
 *
 * Excludes `dogTag.external: true` pets (WP4.4 Q3 provisional imports from a mobile booking's
 * foreign-tag claim) - this clinic never issued them, so they carry no lifecycle this surface can
 * act on (revoke/reactivate/replace all write to the ISSUING clone via THIS clinic's connected
 * operator wallet, which has no authority over a tag some other clinic's clone anchored). */
export async function GET() {
  const {response} = await requireStaffSession();
  if (response) return response;

  await connectToDatabase();
  const [issued, inProgress] = await Promise.all([
    Pet.find({"dogTag.dogTagIdDec": {$exists: true}, "dogTag.external": {$ne: true}})
      .sort({updatedAt: -1})
      .limit(200)
      .lean<PetDoc[]>(),
    MintSession.find({status: {$in: ["pending", "ready", "issuing", "error"]}})
      .sort({createdAt: -1})
      .limit(100)
      .lean<MintSessionDoc[]>(),
  ]);

  return NextResponse.json({issued, inProgress});
}
