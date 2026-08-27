import {NextResponse} from "next/server";
import {setAppointmentTerminalStatus} from "@/lib/booking/lifecycle";
import {connectToDatabase} from "@/lib/db";
import {Appointment, type AppointmentDoc} from "@/lib/models/Appointment";
import {updateAppointmentStatusSchema} from "@/lib/schemas/appointment";
import {badRequest, notFound, requireStaffSession} from "@/lib/staffApi";

export async function GET(_request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id} = await params;
  await connectToDatabase();
  const appointment = await Appointment.findOne({appointmentId: id}).lean<AppointmentDoc>();
  if (!appointment) return notFound("Appointment not found.");
  return NextResponse.json(appointment);
}

/** `PATCH /api/appointments/:id` - status transitions. `cancelled`/`no_show` go through
 * `setAppointmentTerminalStatus` (releases the capacity buckets this appointment held); every
 * other status is a plain field update - the appointment still occupies its slot either way. */
export async function PATCH(request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id} = await params;
  const body = await request.json().catch(() => null);
  const parsed = updateAppointmentStatusSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed status update.", parsed.error.flatten());

  await connectToDatabase();

  if (parsed.data.status === "cancelled" || parsed.data.status === "no_show") {
    const updated = await setAppointmentTerminalStatus(id, parsed.data.status);
    if (!updated) return notFound("Appointment not found.");
    return NextResponse.json(updated);
  }

  const updated = await Appointment.findOneAndUpdate(
    {appointmentId: id},
    {$set: {status: parsed.data.status}},
    {new: true},
  ).lean<AppointmentDoc>();
  if (!updated) return notFound("Appointment not found.");
  return NextResponse.json(updated);
}
