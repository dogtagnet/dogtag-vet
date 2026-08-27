/**
 * Dev/test seed data: a bookable service and a Monday-Friday weekly schedule, so the public
 * booking API has something to return out of the box (`pnpm seed`). Safe to re-run - every write
 * is an upsert or a duplicate-guarded create, never a blind insert.
 *
 * Requires MONGODB_URI (see .env.example). Never run against a production deployment's database
 * without reading what it does first - it will create a demo "General checkup" service if one
 * with that name doesn't already exist.
 */
import "dotenv/config";
import {connectToDatabase} from "@/lib/db";
import {AvailabilityRule} from "@/lib/models/Availability";
import {BookingSettings} from "@/lib/models/Availability";
import {Service} from "@/lib/models/Service";

async function main() {
  await connectToDatabase();

  await BookingSettings.findByIdAndUpdate(
    "singleton",
    {
      $setOnInsert: {
        timezone: "America/New_York",
        minNoticeMinutes: 60,
        maxAdvanceDays: 60,
        slotGranularityMinutes: 30,
      },
    },
    {upsert: true},
  );
  console.log("Booking settings ready.");

  const existingService = await Service.findOne({name: "General checkup"});
  const service =
    existingService ??
    (await Service.create({
      name: "General checkup",
      description: "Routine wellness exam.",
      durationMinutes: 30,
      bufferBeforeMin: 0,
      bufferAfterMin: 10,
      price: {amount: "45.00", currency: "USD"},
      active: true,
      bookableOnline: true,
    }));
  console.log(`Service ready: ${service.name} (${service.serviceId})`);

  // Monday (1) through Friday (5), 9:00-17:00, capacity 2.
  for (let dayOfWeek = 1; dayOfWeek <= 5; dayOfWeek++) {
    const existing = await AvailabilityRule.findOne({dayOfWeek});
    if (existing) continue;
    await AvailabilityRule.create({dayOfWeek, startMinute: 9 * 60, endMinute: 17 * 60, capacity: 2});
  }
  console.log("Weekly availability rules ready (Mon-Fri 9:00-17:00).");

  console.log("Seed complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
