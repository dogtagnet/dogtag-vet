import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Client, buildClientSearchKey, type ClientDoc} from "@/lib/models/Client";
import {createClientSchema} from "@/lib/schemas/client";
import {badRequest, requireStaffSession} from "@/lib/staffApi";

/** `GET /api/clients?q=` - staff-only client list, searched via the denormalized `searchKey`
 * (v1 query vocabulary: `q`). */
export async function GET(request: Request) {
  const {response} = await requireStaffSession();
  if (response) return response;

  await connectToDatabase();
  const q = new URL(request.url).searchParams.get("q")?.trim().toLowerCase();
  const filter = q ? {searchKey: {$regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}} : {};
  const clients = await Client.find(filter).sort({name: 1}).limit(200).lean<ClientDoc[]>();
  return NextResponse.json(clients);
}

export async function POST(request: Request) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const body = await request.json().catch(() => null);
  const parsed = createClientSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed client payload.", parsed.error.flatten());

  await connectToDatabase();
  const created = await Client.create({
    ...parsed.data,
    petIds: [],
    searchKey: buildClientSearchKey(parsed.data),
  });
  return NextResponse.json(created.toObject(), {status: 201});
}
