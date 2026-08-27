import {connectToDatabase} from "@/lib/db";
import {Payment, type PaymentDoc} from "@/lib/models/Payment";
import {requireStaffSession} from "@/lib/staffApi";
import {aggregateMonthlyTotals, monthlyTotalsToCsv} from "@/lib/payments/accounting";

/** `GET /api/payments/accounting/export` - staff-only monthly-totals CSV export. */
export async function GET() {
  const {response} = await requireStaffSession();
  if (response) return response;

  await connectToDatabase();
  const payments = await Payment.find({}).select("createdAt status currency total").lean<PaymentDoc[]>();
  const csv = monthlyTotalsToCsv(aggregateMonthlyTotals(payments));

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": 'attachment; filename="accounting.csv"',
    },
  });
}
