import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Service, type ServiceDoc} from "@/lib/models/Service";
import {createServiceSchema} from "@/lib/schemas/service";
import {badRequest, requireStaffSession} from "@/lib/staffApi";

export async function GET() {
  const {response} = await requireStaffSession();
  if (response) return response;

  await connectToDatabase();
  const services = await Service.find({}).sort({name: 1}).lean<ServiceDoc[]>();
  return NextResponse.json(services);
}

export async function POST(request: Request) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const body = await request.json().catch(() => null);
  const parsed = createServiceSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed service payload.", parsed.error.flatten());

  await connectToDatabase();
  const created = await Service.create(parsed.data);
  return NextResponse.json(created.toObject(), {status: 201});
}
