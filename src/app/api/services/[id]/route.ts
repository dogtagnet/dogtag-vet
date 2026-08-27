import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {Service, type ServiceDoc} from "@/lib/models/Service";
import {updateServiceSchema} from "@/lib/schemas/service";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";

export async function GET(_request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id} = await params;
  await connectToDatabase();
  const service = await Service.findOne({serviceId: id}).lean<ServiceDoc>();
  if (!service) return notFound("Service not found.");
  return NextResponse.json(service);
}

export async function PATCH(request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id} = await params;
  const body = await request.json().catch(() => null);
  const parsed = updateServiceSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed service payload.", parsed.error.flatten());

  await connectToDatabase();
  const updated = await Service.findOneAndUpdate({serviceId: id}, {$set: parsed.data}, {new: true}).lean<ServiceDoc>();
  if (!updated) return notFound("Service not found.");
  return NextResponse.json(updated);
}
