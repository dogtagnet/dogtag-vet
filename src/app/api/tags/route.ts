import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {MintSession, type MintSessionDoc} from "@/lib/models/MintSession";
import {requireStaffSession} from "@/lib/staffApi";

/** `GET /api/tags` - the `/tags` page's DataTable feed: every pet with an issued tag, plus every
 * mint session still in flight (pending/ready/issuing) or needing a retry (error). */
export async function GET() {
  const {response} = await requireStaffSession();
  if (response) return response;

  await connectToDatabase();
  const [issued, inProgress] = await Promise.all([
    Pet.find({"dogTag.dogTagIdDec": {$exists: true}})
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
