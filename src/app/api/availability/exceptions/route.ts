import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {AvailabilityException, type AvailabilityExceptionDoc} from "@/lib/models/Availability";
import {availabilityExceptionSchema} from "@/lib/schemas/availability";
import {badRequest, requireStaffSession} from "@/lib/staffApi";

export async function GET() {
  const {response} = await requireStaffSession();
  if (response) return response;

  await connectToDatabase();
  const exceptions = await AvailabilityException.find({}).sort({date: 1}).lean<AvailabilityExceptionDoc[]>();
  return NextResponse.json(exceptions);
}

export async function POST(request: Request) {
  const {response} = await requireStaffSession();
  if (response) return response;

  const body = await request.json().catch(() => null);
  const parsed = availabilityExceptionSchema.safeParse(body);
  if (!parsed.success) return badRequest("Malformed availability exception.", parsed.error.flatten());

  await connectToDatabase();
  // WP4.7 A3: match (and upsert) on the (date, staffId) PAIR, never `date` alone - now that
  // staffId scopes an exception to one practitioner, matching by date alone would silently
  // overwrite a DIFFERENT practitioner's (or the clinic-wide) exception that happens to share the
  // date instead of creating a new, independent row for this one. `staffId` absent must match ONLY
  // the clinic-wide row (`$exists: false`), never any row that happens to have no staffId AND
  // never accidentally match on a literal `undefined` (Mongo query operators do not treat a
  // missing key and an explicit `$exists: false` the same as a bare `{staffId: undefined}`, which
  // most drivers just drop from the query entirely - matching everything).
  const {staffId, ...rest} = parsed.data;
  const filter = staffId ? {date: parsed.data.date, staffId} : {date: parsed.data.date, staffId: {$exists: false}};
  // Build $set/$unset explicitly rather than `$set: parsed.data` - an update that OMITS staffId
  // (a clinic-wide save) must not leave a PREVIOUSLY-set staffId in place from some earlier row
  // this filter still matches (it cannot, actually, since the filter itself already discriminates
  // on staffId's presence - but being explicit here means a future filter change can't silently
  // reintroduce that hazard), and a `$set` can never itself clear a field the way `$unset` does.
  const update: Record<string, unknown> = staffId ? {$set: {...rest, staffId}} : {$set: rest, $unset: {staffId: ""}};

  try {
    const created = await AvailabilityException.findOneAndUpdate(filter, update, {
      upsert: true,
      new: true,
    }).lean();
    return NextResponse.json(created, {status: 201});
  } catch (err) {
    // The compound (date, staffId) unique index normally makes this filter/update pair race-safe
    // (see `models/Availability.ts`'s doc comment) - but a database that has not yet run the
    // one-time migration described there (`dropIndex("date_1")`, only when its `unique` flag is
    // true) still carries the OLD single-field unique index on `date` alone, which can reject this
    // exact upsert (E11000) even though the filter/update logic above is correct. Surface that as a
    // specific, actionable message rather than a bare 500.
    if (err && typeof err === "object" && "code" in err && (err as {code?: number}).code === 11000) {
      return badRequest(
        staffId
          ? "This clinic's database has not yet been migrated for per-practitioner closures on a date that already has an exception. Ask an operator to complete the WP4.7 index migration, or choose a different date."
          : "An exception for this date already exists.",
      );
    }
    throw err;
  }
}
