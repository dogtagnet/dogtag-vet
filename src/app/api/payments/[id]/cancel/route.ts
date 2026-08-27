import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {notFound, requireStaffSession} from "@/lib/staffApi";
import {cancelPayment} from "@/lib/payments/markPaid";

/** `POST /api/payments/{id}/cancel` - staff-only. Releases the payment's dust reservations so the
 * (chain, token, address, amountBase) tuples it held become available to a fresh invoice. */
export async function POST(_request: Request, {params}: {params: Promise<{id: string}>}) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const {id} = await params;
  await connectToDatabase();
  const updated = await cancelPayment(id);
  if (!updated) return notFound("Payment not found or not pending.");

  return NextResponse.json(updated);
}
