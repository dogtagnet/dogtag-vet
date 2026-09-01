import {randomUUID} from "node:crypto";
import {MongoClient} from "mongodb";
import {expect, test, type Page} from "@playwright/test";
import {addCalendarDays, localDateMinuteToUtcSeconds, todayInTimeZone} from "../src/lib/booking/dst";
import {E2E_MONGO_URI} from "./mongo-fixture";
import {getLastSentTxHash, setRpcReceipt, setRpcScenario} from "./rpcStub";

/**
 * WP4.7 (vet role + per-practitioner availability) - the plan's own section 6 acceptance flows
 * 1-4 (flow 5, clinic-mode regression, needs no new test cases here: it is proven by every
 * PRE-EXISTING spec in this suite - especially mobile-booking.spec.ts - passing unmodified
 * alongside this file, which the full suite run already covers). Flow 6 (mobile/Phase B) is a
 * separate, later phase, out of scope for this file.
 *
 * Two hard-won setup rules, both found empirically while building this file (see the throwaway
 * checks referenced in wp4.7A-progress.md's LOG for the full diagnosis):
 *
 * 1. `ensureStaffForEmail`'s bootstrap rule ("the first staff row this deployment ever creates is
 *    owner") checks `Staff.countDocuments()` - any direct-Mongo staff seed MUST happen AFTER, not
 *    before, owner@example.com's first dev-login in a test, or the owner silently bootstraps as a
 *    plain "staff" instead and every following assertion breaks in confusing ways.
 * 2. Mongoose pluralizes the "Staff" model to the "staffs" collection (not "staff") - confirmed
 *    via a direct `mongoose.model("Staff", ...).collection.name` check, not assumed.
 *
 * Every test that switches `schedulingMode` restores "clinic" in a `finally` block covering the
 * whole test body (not just an `afterEach`/`afterAll` hook) - the exact discipline the WP4.7A
 * progress log's own item-6 LOG entry documents needing, after an earlier throwaway diagnostic
 * script left practitioner mode switched on and broke booking-config-timezone.spec.ts's clinic-
 * mode assumptions for the rest of that run.
 */

const VET_EMAIL = "vet-wp47@example.com";
const VET_WALLET = "0x00000000000000000000000000000000000000cd";
const CLONE_ADDRESS = "0x00000000000000000000000000000000000000ab";

async function devLogin(page: Page, email: string): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", {name: "Dev sign in (test only)"}).click();
  await expect(page).toHaveURL(/\/dashboard$/, {timeout: 15_000});
}

async function mongo(): Promise<MongoClient> {
  const client = new MongoClient(E2E_MONGO_URI);
  await client.connect();
  return client;
}

test.describe.serial("flow 1+2: role gating, wallet, and the D4 operator panel", () => {
  test("owner invites a vet, who then sees Tags; a fresh uninvited email does not", async ({page}) => {
    // Bootstrap: owner@example.com is the FIRST staff row this deployment ever creates (every
    // other spec in this suite relies on the exact same bootstrap).
    await devLogin(page, "owner@example.com");

    await page.goto("/settings");
    await page.getByLabel("Invite by email").fill(VET_EMAIL);
    await page.getByLabel("Role to invite as").selectOption("vet");
    await page.getByRole("button", {name: "Invite"}).click();
    await expect(page.getByText(`Invited ${VET_EMAIL}`)).toBeVisible({timeout: 15_000});

    await page.context().clearCookies();
    await devLogin(page, VET_EMAIL);
    await expect(page.getByRole("link", {name: "Tags", exact: true})).toBeVisible();
    await page.goto("/tags");
    await expect(page).toHaveURL(/\/tags$/);

    await page.context().clearCookies();
    // A brand-new email with no prior invite - dev-login is unrestricted (test-only), but the
    // bootstrap owner already exists, so ensureStaffForEmail provisions this one as plain "staff",
    // exactly the real-world "never invited, never given a role" case section 6 flow 1 describes.
    await devLogin(page, `staff-wp47-${randomUUID().slice(0, 8)}@example.com`);
    await expect(page.getByRole("link", {name: "Tags", exact: true})).not.toBeVisible();
    await page.goto("/tags");
    await expect(page).toHaveURL(/\/dashboard\?notice=vet-required/);
    await expect(page.getByText("Vet or owner access required")).toBeVisible();
  });

  test("owner records the vet's wallet, grants operator on chain, then revokes it", async ({page}) => {
    // D4's own text: "each vet/owner staff row can record a personal walletAddress" - item 3
    // (A3) made editing that field owner-only ("self-service ... OUT of scope - owner edits
    // all"), so this is the owner recording it on the vet's behalf, not the vet themselves; the
    // plan's prose ("Vet records wallet") describes the end state, not literally who clicks Save.
    await devLogin(page, "owner@example.com");

    const client = await mongo();
    // ClinicSettings uses a fixed STRING `_id` ("singleton", ClinicSettings.ts's own
    // CLINIC_SETTINGS_ID) by design, not the driver's default ObjectId - the explicit generic
    // tells the driver's types to expect that instead of rejecting a string `_id` filter.
    await client
      .db()
      .collection<{_id: string; cloneAddress?: string}>("clinicsettings")
      .updateOne({_id: "singleton"}, {$set: {cloneAddress: CLONE_ADDRESS}}, {upsert: true});
    await client.close();

    await page.goto("/settings");
    const vetCard = page.locator("div.rounded-control", {hasText: VET_EMAIL});
    // update() (StaffSection.tsx) has no success snackbar on its happy path (only a danger one on
    // failure), so there is nothing to visibly wait for except the PATCH itself completing -
    // reloading before it resolves races the write (found empirically: the checkbox's own PATCH
    // still had time to land by the time of the first attempt's reload, but the wallet field's
    // did not, leaving the value empty after reload).
    const isPatch = (url: string) => url.includes("/api/settings/staff/");
    await Promise.all([
      page.waitForResponse((res) => isPatch(res.url()) && res.request().method() === "PATCH"),
      vetCard.getByRole("checkbox", {name: "Bookable"}).check(),
    ]);
    await expect(vetCard.getByRole("checkbox", {name: "Bookable"})).toBeChecked();
    await vetCard.getByLabel("Wallet address").fill(VET_WALLET);
    await Promise.all([
      page.waitForResponse((res) => isPatch(res.url()) && res.request().method() === "PATCH"),
      vetCard.getByLabel("Wallet address").blur(),
    ]);
    await page.reload();
    const vetCardAfterReload = page.locator("div.rounded-control", {hasText: VET_EMAIL});
    await expect(vetCardAfterReload.getByRole("checkbox", {name: "Bookable"})).toBeChecked();
    await expect(vetCardAfterReload.getByLabel("Wallet address")).toHaveValue(VET_WALLET);

    // Scoped to the panel itself - "Active"/"Inactive" would otherwise also match the STAFF
    // ROSTER's own disabled-status badges elsewhere on this same page.
    const panel = page.locator("section", {hasText: "Issuance operators"});
    await expect(panel.getByText("Inactive")).toBeVisible({timeout: 15_000});

    await panel.getByRole("button", {name: "Add operator"}).click();
    await expect(panel.getByRole("button", {name: "Confirming..."})).toBeVisible();
    await expect.poll(async () => getLastSentTxHash(), {timeout: 15_000}).not.toBeNull();
    const addHash = await getLastSentTxHash();
    await setRpcReceipt(addHash!, "success");
    // rpcStub is a stateless-per-call mock, not a real EVM: eth_sendTransaction never causes a
    // later eth_call to reflect the write on its own, so the read half is scripted separately -
    // exactly like every other write-then-read flow already scripted in this suite.
    await setRpcScenario("operators", CLONE_ADDRESS, [VET_WALLET], true);
    await expect(panel.getByText("Active", {exact: true})).toBeVisible({timeout: 15_000});

    await panel.getByRole("button", {name: "Remove operator"}).click();
    await expect(panel.getByRole("button", {name: "Confirming..."})).toBeVisible();
    await expect.poll(async () => getLastSentTxHash(), {timeout: 15_000}).not.toBe(addHash);
    const removeHash = await getLastSentTxHash();
    await setRpcReceipt(removeHash!, "success");
    await setRpcScenario("operators", CLONE_ADDRESS, [VET_WALLET], false);
    await expect(panel.getByText("Inactive", {exact: true})).toBeVisible({timeout: 15_000});
  });
});

const VET_B_EMAIL = "vetb-wp47@example.com";

test.describe.serial("flow 3: per-practitioner mode, union availability, and booking", () => {
  test.afterAll(async () => {
    // Belt and suspenders alongside each test's own try/finally below - if a failure ever
    // happens somewhere this file does not anticipate, the LAST line of defense is still "clinic
    // mode before this file's tests are considered done", never leaving practitioner mode set for
    // whatever spec file runs next in this shared-DB invocation.
    const client = await mongo();
    await client.db().collection("bookingsettings").updateMany({}, {$set: {schedulingMode: "clinic"}});
    await client.close();
  });

  test("switching to practitioner mode is blocked until a bookable practitioner has hours", async ({page}) => {
    await devLogin(page, "owner@example.com");
    await page.goto("/settings");
    await page.getByLabel("Scheduling mode").selectOption("practitioner");
    await page.getByRole("button", {name: "Save booking configuration"}).click();
    await expect(
      page.getByText("Switching to per-practitioner scheduling needs at least one vet or owner marked bookable"),
    ).toBeVisible({timeout: 10_000});

    const settings = await (await page.request.get("/api/settings")).json();
    expect(settings.schedulingMode ?? "clinic").toBe("clinic");
  });

  test("two practitioners with different hours produce a union availability with correct practitionerIds; Any auto-assigns; a named re-book of the same slot conflicts", async ({page}) => {
    await devLogin(page, "owner@example.com");

    try {
      const client = await mongo();
      // Ensure (not merely assert) vetA/vetB exist and are bookable, so this flow stands on its own
      // regardless of whether flow 1+2 already ran successfully in this same suite invocation - a
      // failure anywhere upstream (this file's own tests, or, empirically observed on this shared
      // machine, unrelated system-level resource contention causing a navigation timeout) must not
      // cascade into unrelated failures downstream. See flow 4's matching comment for the same
      // reasoning. $setOnInsert preserves an already-existing row's real staffId (e.g. the one
      // flow 1's actual invite flow created) instead of clobbering it; only a genuinely-missing row
      // gets a fresh random one.
      for (const email of [VET_EMAIL, VET_B_EMAIL]) {
        await client.db().collection("staffs").updateOne(
          {email},
          {$set: {email, role: "vet", disabled: false, bookable: true}, $setOnInsert: {staffId: randomUUID()}},
          {upsert: true},
        );
      }
      const vetADoc = await client.db().collection("staffs").findOne({email: VET_EMAIL});
      const vetBDoc = await client.db().collection("staffs").findOne({email: VET_B_EMAIL});
      await client.close();
      const vetAId = vetADoc!.staffId as string;
      const vetBId = vetBDoc!.staffId as string;

      // Distinct, time-of-day-based hours (not day-of-week-based) so this passes no matter which
      // real weekday the suite happens to run on: vetA covers every morning, vetB every afternoon,
      // every day of the week. Seeded directly via the same route saveHours() itself calls (A5's
      // own UI-driven flow for this is already covered by item 5's own visual verification - this
      // flow is about the resulting availability MATH and booking mechanics, not re-driving 14
      // checkbox/time-input pairs per practitioner through the UI).
      for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
        const post = (staffId: string, startMinute: number, endMinute: number) =>
          page.request.post("/api/availability/rules", {
            data: {dayOfWeek, startMinute, endMinute, capacity: 1, staffId},
          });
        expect((await post(vetAId, 9 * 60, 12 * 60)).ok()).toBe(true);
        expect((await post(vetBId, 13 * 60, 17 * 60)).ok()).toBe(true);
      }

      await page.goto("/settings");
      await page.getByLabel("Scheduling mode").selectOption("practitioner");
      await page.getByRole("button", {name: "Save booking configuration"}).click();
      await expect(page.getByText("Booking settings saved")).toBeVisible({timeout: 10_000});

      const services = await (await page.request.get("/v1/booking/services")).json();
      const service = services.find((s: {name: string}) => s.name === "General checkup");
      expect(service).toBeTruthy();

      // A window starting comfortably past both minNoticeMinutes and "now", short enough that
      // computing an exact expected slot count is not the point - finding a real vetA-only and a
      // real vetB-only slot from the API's OWN response is.
      const from = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
      const availabilityRes = await page.request.get(
        `/v1/booking/availability?serviceId=${service.id}&from=${from.toISOString()}&to=${to.toISOString()}`,
      );
      const availability = await availabilityRes.json();
      expect(availability.practitioners).toEqual(
        expect.arrayContaining([
          {id: vetAId, name: expect.any(String)},
          {id: vetBId, name: expect.any(String)},
        ]),
      );

      type Slot = {startAt: string; endAt: string; practitionerIds: string[]};
      const slots: Slot[] = availability.slots;
      const vetAOnlySlot = slots.find((s) => s.practitionerIds.length === 1 && s.practitionerIds[0] === vetAId);
      const vetBOnlySlot = slots.find((s) => s.practitionerIds.length === 1 && s.practitionerIds[0] === vetBId);
      expect(vetAOnlySlot, "expected at least one morning slot covered by vetA alone").toBeTruthy();
      expect(vetBOnlySlot, "expected at least one afternoon slot covered by vetB alone").toBeTruthy();

      // Book "Any" (no practitionerId) against the vetA-only slot - the union means this slot is
      // offered at all only because vetA covers it, so deterministic auto-assign has exactly one
      // candidate and must land on vetA.
      const bookAnyRes = await page.request.post("/v1/booking/book", {
        data: {
          serviceId: service.id,
          startAt: vetAOnlySlot!.startAt,
          client: {name: "WP4.7 Flow3 Client", email: `flow3-${randomUUID().slice(0, 8)}@example.com`},
        },
      });
      expect(bookAnyRes.status()).toBe(201);
      const booked = await bookAnyRes.json();
      const statusRes = await page.request.get(`/v1/booking/appointments/${booked.appointmentId}?token=${booked.token}`);
      expect((await statusRes.json()).status).toBe("confirmed");

      // Re-booking the SAME instant, explicitly naming vetA (now at capacity 1/1 for that slot),
      // must conflict cleanly - never a bare 500, never a silent double-book.
      const conflictRes = await page.request.post("/v1/booking/book", {
        data: {
          serviceId: service.id,
          startAt: vetAOnlySlot!.startAt,
          practitionerId: vetAId,
          client: {name: "WP4.7 Flow3 Conflict", email: `flow3-conflict-${randomUUID().slice(0, 8)}@example.com`},
        },
      });
      expect(conflictRes.status()).toBe(409);
    } finally {
      const client = await mongo();
      await client.db().collection("bookingsettings").updateMany({}, {$set: {schedulingMode: "clinic"}});
      await client.close();
    }
  });
});

test.describe.serial("flow 4: staff calendar - week filter, day columns, unassigned banner", () => {
  test.afterAll(async () => {
    const client = await mongo();
    await client.db().collection("bookingsettings").updateMany({}, {$set: {schedulingMode: "clinic"}});
    await client.db().collection("appointments").deleteMany({clientName: {$regex: "^WP4\\.7 Flow4"}});
    await client.close();
  });

  test("week view filters by practitioner; day view renders per-practitioner columns; the unassigned banner prompts assignment until one is made", async ({page}) => {
    await devLogin(page, "owner@example.com");

    try {
      const client = await mongo();
      // Ensure (not merely assert) vetA/vetB exist and are bookable, independent of flow 1+2/flow 3
      // having already run in this same suite invocation - see flow 3's matching comment for the
      // full reasoning. $setOnInsert preserves an already-existing row's real staffId.
      for (const email of [VET_EMAIL, VET_B_EMAIL]) {
        await client.db().collection("staffs").updateOne(
          {email},
          {$set: {email, role: "vet", disabled: false, bookable: true}, $setOnInsert: {staffId: randomUUID()}},
          {upsert: true},
        );
      }
      const vetADoc = await client.db().collection("staffs").findOne({email: VET_EMAIL});
      const vetBDoc = await client.db().collection("staffs").findOne({email: VET_B_EMAIL});
      const vetA = {staffId: vetADoc!.staffId as string, email: VET_EMAIL};
      const vetB = {staffId: vetBDoc!.staffId as string, email: VET_B_EMAIL};

      await client.db().collection("bookingsettings").updateMany({}, {$set: {schedulingMode: "practitioner"}});
      const bookingSettings = await client.db().collection("bookingsettings").findOne({});
      const timezone = (bookingSettings?.timezone as string | undefined) ?? "America/New_York";
      // A few days out, same margin flow 3 uses - and, critically, a REAL clinic-local wall time
      // inside each vet's actual hours (vetA 09:00-12:00, vetB 13:00-17:00, both set for every
      // dayOfWeek in flow 3), computed with the app's OWN timezone helper rather than raw "now":
      // an arbitrary real-world "now" can land at any hour of the day, and reassignPractitioner
      // (lifecycle.ts) validates the TARGET practitioner's own hours cover the appointment - found
      // empirically, the first version of this test seeded appointments at raw "now" and the
      // assignment step below silently failed outside_hours whenever the suite happened to run
      // outside vetB's window.
      const targetDate = addCalendarDays(todayInTimeZone(timezone), 3);
      const vetAStart = localDateMinuteToUtcSeconds(targetDate, 10 * 60, timezone)!;
      const vetBStart = localDateMinuteToUtcSeconds(targetDate, 14 * 60, timezone)!;
      await client.db().collection("appointments").insertMany([
        {
          appointmentId: randomUUID(),
          startAt: vetAStart,
          endAt: vetAStart + 1800,
          status: "scheduled",
          source: "staff",
          clientName: "WP4.7 Flow4 Assigned Client",
          petName: "Flow4 Pet A",
          petIds: [],
          ownerClientIds: [],
          practitionerStaffId: vetA.staffId,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          appointmentId: randomUUID(),
          startAt: vetBStart,
          endAt: vetBStart + 1800,
          status: "scheduled",
          source: "staff",
          clientName: "WP4.7 Flow4 Unassigned Client",
          petName: "Flow4 Pet B",
          petIds: [],
          ownerClientIds: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      await client.close();

      // Week view - filter Select lists both practitioners plus Unassigned; filtering to vetA
      // hides the unassigned chip. Explicit ?date= so the calendar's default ("today") does not
      // need to happen to fall in the same clinic-local week as targetDate.
      await page.goto(`/calendar?view=week&date=${targetDate}`);
      const filter = page.getByLabel("Filter by practitioner", {exact: true});
      await expect(filter).toBeVisible();
      await expect(page.getByText("WP4.7 Flow4 Assigned Client")).toBeVisible();
      await expect(page.getByText("WP4.7 Flow4 Unassigned Client")).toBeVisible();
      await filter.selectOption(vetA.staffId);
      await expect(page.getByText("WP4.7 Flow4 Assigned Client")).toBeVisible();
      await expect(page.getByText("WP4.7 Flow4 Unassigned Client")).not.toBeVisible();
      await filter.selectOption("");

      // Day view - one column per bookable practitioner (headerPrimary is practitionerDisplayName,
      // which falls back to the email's local part - neither vetA nor vetB has a displayName set),
      // plus an Unassigned column since one exists.
      // Scoped to the column-header span specifically (className="truncate ...", CalendarView.tsx)
      // - a plain getByText also matches the SAME name inside the practitioner filter's own
      // <option>, a strict-mode violation confirmed empirically.
      await page.goto(`/calendar?view=day&date=${targetDate}`);
      await expect(page.locator("span.truncate", {hasText: vetA.email.split("@")[0] ?? vetA.email})).toBeVisible();
      await expect(page.locator("span.truncate", {hasText: vetB.email.split("@")[0] ?? vetB.email})).toBeVisible();
      await expect(page.locator("span.truncate", {hasText: "Unassigned"})).toBeVisible();

      // The D3 banner - present while an unassigned appointment sits in the visible range.
      const bannerText = page.getByText("Unassigned appointments need a practitioner");
      await expect(bannerText).toBeVisible();

      // Assignment flow - open the unassigned chip, assign vetB, confirm the banner clears. This is
      // the first navigation to /appointments/[id] anywhere in this file, so in dev mode it also
      // pays a one-time route compile on top of the router.push + RSC fetch (CalendarView.tsx's
      // appointment button, confirmed a plain router.push - not a locator or click-target issue) -
      // an explicit generous timeout here matches every other state-changing assertion in this file.
      await page.getByText("WP4.7 Flow4 Unassigned Client").click();
      await expect(page).toHaveURL(/\/appointments\/[^/]+$/, {timeout: 15_000});
      const practitionerSelect = page.getByLabel("Practitioner", {exact: true});
      await practitionerSelect.selectOption(vetB.staffId);
      // The snackbar ("Practitioner updated") auto-dismisses after 4s (Snackbar.tsx) - waiting for
      // the PATCH itself is the reliable signal, not racing a transient toast.
      await Promise.all([
        page.waitForResponse((res) => /\/api\/appointments\/[^/]+$/.test(res.url()) && res.request().method() === "PATCH"),
        page.getByRole("button", {name: "Save practitioner"}).click(),
      ]);

      await page.goto(`/calendar?view=day&date=${targetDate}`);
      await expect(page.getByText("Unassigned appointments need a practitioner")).not.toBeVisible();
    } finally {
      const client = await mongo();
      await client.db().collection("bookingsettings").updateMany({}, {$set: {schedulingMode: "clinic"}});
      await client.db().collection("appointments").deleteMany({clientName: {$regex: "^WP4\\.7 Flow4"}});
      await client.close();
    }
  });
});
