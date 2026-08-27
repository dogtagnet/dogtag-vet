import {NextResponse} from "next/server";
import {auth} from "@/auth";
import {connectToDatabase} from "@/lib/db";
import {getClinicSettings, updateClinicSettings} from "@/lib/models/ClinicSettings";
import {clinicSettingsInputSchema} from "@/lib/schemas/settings";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({error: {code: "unauthorized", message: "Sign in required."}}, {status: 401});
  }
  await connectToDatabase();
  const settings = await getClinicSettings();
  return NextResponse.json(settings);
}

export async function PATCH(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({error: {code: "unauthorized", message: "Sign in required."}}, {status: 401});
  }

  const body = await request.json().catch(() => null);
  const parsed = clinicSettingsInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {error: {code: "invalid_input", message: "Malformed settings payload.", details: parsed.error.flatten()}},
      {status: 400},
    );
  }

  await connectToDatabase();
  const updated = await updateClinicSettings(parsed.data);
  return NextResponse.json(updated);
}
