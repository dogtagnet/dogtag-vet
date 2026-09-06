import {randomUUID} from "node:crypto";
import {MongoClient} from "mongodb";
import {expect, test, type Page} from "@playwright/test";
import {addCalendarDays, todayInTimeZone} from "../src/lib/booking/dst";
import {E2E_MONGO_URI} from "./mongo-fixture";

/**
 * WP4.13 (Kenneth issue 3: "split the name of the vet from display name to first name, last
 * name... qualifications / title field... government accreditation number") - the plan's own
 * section 3.5 e2e list: an owner fills first/last/title(+accreditation) for a vet -> the
 * Practitioner profiles header and the roster Name column both show the composed "Jane Smith,
 * DVM" line; per-practitioner mode's calendar day-view column shows that same line with initials
 * "JS"; the public availability wire and the public /book page both carry the composed name and
 * NEVER the accreditation number; the vet edits their own title via the new "My profile" card.
 * `e2e/practitioner-mode.spec.ts` and `e2e/vet-wallet-status.spec.ts` keep relying on the
 * email-local-part fallback tier for their own vets (vet-wp47@example.com, vetb-wp47@example.com,
 * vet-wp47c@example.com) - none of those are touched here, and this file uses its own
 * "vet-wp413@example.com" throughout (no substring relation either direction to any of them).
 *
 * Two landmines this file's own locators are built around (found before writing a single test,
 * not discovered by a failing run):
 * 1. StaffSection's "Practitioner profiles" card and the new MyProfileSection ("My profile") card
 *    render the SAME four field labels ("First name", "Last name", "Title / qualification",
 *    "Government accreditation number") for a vet/owner session that is ALSO viewing their own
 *    row - a page-level `getByLabel` for any of them is a strict-mode violation the moment both
 *    cards are visible together. Every locator below scopes to its own card/section first.
 * 2. `OperatorsSection`/`OperatorRow` deliberately renders only `practitionerDisplayName`, never
 *    the email - untouched by this WP. Nothing here reads the operators panel at all.
 */

const VET_EMAIL = "vet-wp413@example.com";
const LEGACY_VET_EMAIL = "vet-wp413-legacy@example.com";
const ACCREDITATION_NUMBER = "USDA-56789";

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

/** Scoped to ONE practitioner's own card in the "Practitioner profiles" FormSection, by their
 * email (kept as a caption under the composed-name header for exactly this reason - see
 * StaffSection.tsx). Never a bare page-level `getByLabel`/`getByText` for this card's fields. */
function practitionerCard(page: Page, email: string) {
  return page.locator("section", {hasText: "Practitioner profiles"}).locator("div.rounded-control", {hasText: email});
}

/** Scoped to the self-service "My profile" card - the WP4.13 sibling of MyWalletSection's own
 * `myWalletCard` helper in vet-wallet-status.spec.ts. */
function myProfileCard(page: Page) {
  return page.locator("section", {hasText: "My profile"});
}

/** Same broad-prefix convention practitioner-mode.spec.ts's own `isPatch` helper already
 * established for this exact route family (now also covering the two `/me/...` sub-routes, which
 * is fine here - each `Promise.all` below only ever has ONE PATCH in flight at a time). */
function isStaffPatch(url: string): boolean {
  return url.includes("/api/settings/staff/");
}

/** Same idempotent, inspect-first seeding as practitioner-mode.spec.ts's own
 * `ensurePractitionerHours` - a bookable practitioner needs at least one weekly hours rule of
 * their own before `hasPractitionerReadyForSchedulingMode` will allow switching to per-practitioner
 * scheduling at all. */
async function ensurePractitionerHours(page: Page, staffId: string, startMinute: number, endMinute: number): Promise<void> {
  const existing = (await (await page.request.get("/api/availability/rules")).json()) as {staffId?: string}[];
  if (existing.some((r) => r.staffId === staffId)) return;
  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
    const res = await page.request.post("/api/availability/rules", {data: {dayOfWeek, startMinute, endMinute, capacity: 1, staffId}});
    expect(res.ok()).toBe(true);
  }
}

test.describe.serial("WP4.13 - practitioner first/last name, title, accreditation", () => {
  test.afterAll(async () => {
    // Belt and suspenders alongside the mode-switch test's own try/finally below - never leave
    // practitioner mode on for whichever spec file runs next in this shared-DB invocation (the
    // exact discipline practitioner-mode.spec.ts's flow 3/flow 4 already follow).
    const client = await mongo();
    await client.db().collection("bookingsettings").updateMany({}, {$set: {schedulingMode: "clinic"}});
    await client.close();
  });

  test("owner fills first/last/title/accreditation for a vet; the composed name shows in the Practitioner profiles header and the roster Name column", async ({page}) => {
    // Bootstrap: owner@example.com is the FIRST staff row this deployment ever creates (every
    // other spec in this suite relies on the exact same bootstrap) - devLogin BEFORE any
    // direct-Mongo staff seed.
    await devLogin(page, "owner@example.com");

    await page.goto("/settings");
    await page.getByLabel("Invite by email").fill(VET_EMAIL);
    await page.getByLabel("Role to invite as").selectOption("vet");
    await page.getByRole("button", {name: "Invite"}).click();
    await expect(page.getByText(`Invited ${VET_EMAIL}`)).toBeVisible({timeout: 15_000});

    const card = practitionerCard(page, VET_EMAIL);
    await expect(card).toBeVisible();

    await Promise.all([
      page.waitForResponse((res) => isStaffPatch(res.url()) && res.request().method() === "PATCH"),
      card.getByRole("checkbox", {name: "Bookable"}).check(),
    ]);
    await expect(card.getByRole("checkbox", {name: "Bookable"})).toBeChecked();

    await card.getByLabel("First name").fill("Jane");
    await Promise.all([
      page.waitForResponse((res) => isStaffPatch(res.url()) && res.request().method() === "PATCH"),
      card.getByLabel("First name").blur(),
    ]);
    await card.getByLabel("Last name").fill("Smith");
    await Promise.all([
      page.waitForResponse((res) => isStaffPatch(res.url()) && res.request().method() === "PATCH"),
      card.getByLabel("Last name").blur(),
    ]);
    await card.getByLabel("Title / qualification").fill("DVM");
    await Promise.all([
      page.waitForResponse((res) => isStaffPatch(res.url()) && res.request().method() === "PATCH"),
      card.getByLabel("Title / qualification").blur(),
    ]);
    await card.getByLabel("Government accreditation number").fill(ACCREDITATION_NUMBER);
    await Promise.all([
      page.waitForResponse((res) => isStaffPatch(res.url()) && res.request().method() === "PATCH"),
      card.getByLabel("Government accreditation number").blur(),
    ]);

    await page.reload();
    const cardAfterReload = practitionerCard(page, VET_EMAIL);
    await expect(cardAfterReload.getByText("Jane Smith, DVM", {exact: true})).toBeVisible();
    await expect(cardAfterReload.getByLabel("First name")).toHaveValue("Jane");
    await expect(cardAfterReload.getByLabel("Last name")).toHaveValue("Smith");
    await expect(cardAfterReload.getByLabel("Title / qualification")).toHaveValue("DVM");
    await expect(cardAfterReload.getByLabel("Government accreditation number")).toHaveValue(ACCREDITATION_NUMBER);
    // No legacy-displayName hint for a vet who was never given one in the first place.
    await expect(cardAfterReload.getByText("legacy display name")).toHaveCount(0);

    // WP4.13 fix-round regression: toggling ONE unrelated field (Bookable) must never blank the
    // name/title/accreditation fields just set above - the optimistic patch merge once re-added
    // every OTHER nullable field to the merge object as an explicit `undefined` on every
    // single-field edit, and `{...s, ...optimisticPatch}` overwrote the row's real values with it.
    // `refresh()` always repaired this within a render or two - which is exactly the trap: a plain
    // `expect().toBeVisible()` RETRIES for its own default ~5s budget, so it happily waits out the
    // repair and passes whether or not the bug exists, delayed PATCH or not (confirmed by running
    // this block against the unfixed component - it passed silently until the timeouts below were
    // added). Holding the PATCH response open widens the window; the SHORT per-assertion timeouts
    // are what actually make the difference, forcing each check to sample the synchronous
    // optimistic state instead of tolerating however long the real round-trip takes to correct it.
    const delayedUncheckPatch = page.waitForResponse((res) => isStaffPatch(res.url()) && res.request().method() === "PATCH");
    await page.route("**/api/settings/staff/*", async (route) => {
      if (route.request().method() === "PATCH") await new Promise((resolve) => setTimeout(resolve, 3_000));
      await route.continue();
    });
    await cardAfterReload.getByRole("checkbox", {name: "Bookable"}).uncheck();
    await expect(cardAfterReload.getByText("Jane Smith, DVM", {exact: true})).toBeVisible({timeout: 1_000});
    await expect(cardAfterReload.getByLabel("First name")).toHaveValue("Jane", {timeout: 1_000});
    await expect(cardAfterReload.getByLabel("Last name")).toHaveValue("Smith", {timeout: 1_000});
    await expect(cardAfterReload.getByLabel("Title / qualification")).toHaveValue("DVM", {timeout: 1_000});
    await expect(cardAfterReload.getByLabel("Government accreditation number")).toHaveValue(ACCREDITATION_NUMBER, {timeout: 1_000});
    // Let the delayed uncheck's OWN PATCH land (not just unroute) before issuing another write to
    // the same row - two overlapping in-flight PATCHes here could resolve out of order server-side
    // (the artificially delayed bookable:false landing AFTER the restore's bookable:true below),
    // leaving the DB on bookable:false despite this test's own client-side state and assertions
    // all showing true. `page.unroute` only stops NEW requests from being intercepted - it does
    // not cancel or wait out this handler's already-running 3s timer.
    await delayedUncheckPatch;
    await page.unroute("**/api/settings/staff/*");

    // Restore Bookable - test 2 (per-practitioner mode) needs this vet bookable. Issued only after
    // the line above confirms the delayed uncheck's write has fully landed.
    await Promise.all([
      page.waitForResponse((res) => isStaffPatch(res.url()) && res.request().method() === "PATCH"),
      cardAfterReload.getByRole("checkbox", {name: "Bookable"}).check(),
    ]);
    await expect(cardAfterReload.getByRole("checkbox", {name: "Bookable"})).toBeChecked();

    // D1 fix round (grader): a too-long Title must show an inline error INSIDE this
    // practitioner's own card (scoped via `cardAfterReload`, never a bare page-level locator -
    // the same field label exists on the "My profile" card too) AND must not discard what the
    // owner typed. Two separate mechanisms were broken before this fix round: (1) `StaffSection`
    // never wired `FormField`'s own `error` prop at all (a 400 surfaced only as a generic
    // snackbar), and (2) `update()`'s failure path unconditionally called
    // `setStaff(previousStaff)`, which flips `ProfileTextField`'s `storedValue` prop back to the
    // last-saved value and fires its `useEffect([storedValue])`, silently discarding the draft -
    // exactly the two-part bug `MyProfileSection` already avoided (plan RESULT deviation 7). The
    // second assertion below (the field still holding the 41-character string) is what actually
    // pins the second mechanism; without it, a fixer who wires the `error` prop but leaves the
    // blanket rollback in place would still pass on a half-fix that reads worse than the previous
    // snackbar-only behavior, not better - the grader's own explicit warning.
    const tooLongTitle = "T".repeat(41);
    await cardAfterReload.getByLabel("Title / qualification").fill(tooLongTitle);
    await Promise.all([
      page.waitForResponse((res) => isStaffPatch(res.url()) && res.request().method() === "PATCH"),
      cardAfterReload.getByLabel("Title / qualification").blur(),
    ]);
    await expect(cardAfterReload.getByText(/at most 40 character/i)).toBeVisible();
    await expect(cardAfterReload.getByLabel("Title / qualification")).toHaveValue(tooLongTitle);

    // Restore a valid title - test 2 (per-practitioner mode) asserts the composed "Jane Smith,
    // DVM" line, including this field.
    await cardAfterReload.getByLabel("Title / qualification").fill("DVM");
    await Promise.all([
      page.waitForResponse((res) => isStaffPatch(res.url()) && res.request().method() === "PATCH"),
      cardAfterReload.getByLabel("Title / qualification").blur(),
    ]);
    await expect(cardAfterReload.getByLabel("Title / qualification")).toHaveValue("DVM");
    await expect(cardAfterReload.getByText(/at most 40 character/i)).toHaveCount(0);

    // The roster's own Name column (Staff access, a SEPARATE section from Practitioner profiles -
    // scoped so this can never accidentally match the practitioner card's own header instead).
    const roster = page.locator("section", {hasText: "Staff access"});
    await expect(roster.getByRole("cell", {name: "Jane Smith, DVM", exact: true})).toBeVisible();
  });

  test("per-practitioner mode: the calendar day-view column and the public availability wire both show the composed name and initials; the accreditation number never appears on the public /book page or in the availability JSON", async ({page}) => {
    await devLogin(page, "owner@example.com");

    try {
      const staffList = (await (await page.request.get("/api/settings/staff")).json()) as {staffId: string; email: string}[];
      const vetStaffId = staffList.find((s) => s.email === VET_EMAIL)?.staffId;
      expect(vetStaffId, "expected the vet created by the previous test to still exist").toBeTruthy();

      await ensurePractitionerHours(page, vetStaffId!, 9 * 60, 17 * 60);

      await page.goto("/settings");
      await page.getByLabel("Scheduling mode").selectOption("practitioner");
      await page.getByRole("button", {name: "Save booking configuration"}).click();
      await expect(page.getByText("Booking settings saved")).toBeVisible({timeout: 10_000});

      const bookingSettings = await (await page.request.get("/api/availability/settings")).json();
      expect(bookingSettings.schedulingMode).toBe("practitioner");
      const timezone = bookingSettings.timezone as string;
      const targetDate = addCalendarDays(todayInTimeZone(timezone), 3);

      // Calendar day-view column: the composed name AND initials "JS" - both derived from
      // firstName/lastName directly (never by splitting the composed, titled line - the calendar
      // trap this WP's own plan calls out).
      await page.goto(`/calendar?view=day&date=${targetDate}`);
      await expect(page.locator("span.truncate", {hasText: "Jane Smith, DVM"})).toBeVisible();
      await expect(
        page.locator("span.rounded-badge").filter({hasText: /^JS$/}),
      ).toBeVisible();

      const services = (await (await page.request.get("/v1/booking/services")).json()) as Array<{id: string; name: string}>;
      const service = services.find((s) => s.name === "General checkup");
      expect(service).toBeTruthy();

      // Public availability wire: exactly the composed name, never initials or the accreditation
      // number (see availabilityRouteWireShape.integration.test.ts for the unit-level proof this
      // e2e check corroborates end to end).
      const from = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
      const availabilityRes = await page.request.get(
        `/v1/booking/availability?serviceId=${service!.id}&from=${from.toISOString()}&to=${to.toISOString()}`,
      );
      const availabilityBody = await availabilityRes.json();
      expect(availabilityBody.practitioners).toEqual(expect.arrayContaining([{id: vetStaffId, name: "Jane Smith, DVM"}]));
      const rawAvailabilityText = JSON.stringify(availabilityBody);
      expect(rawAvailabilityText).not.toContain(ACCREDITATION_NUMBER);
      expect(rawAvailabilityText).not.toContain("initials");
      expect(rawAvailabilityText).not.toContain("accreditationNumber");

      // The public /book page: drive the actual wizard (service -> date -> Check availability) so
      // the practitioner name reaching a real browser render is proven, not just the JSON.
      await page.goto("/book");
      await page.getByLabel("Service").selectOption(service!.id);
      await page.locator("#book-date").fill(targetDate);
      await page.getByRole("button", {name: "Check availability"}).click();
      await expect(page.locator("#book-practitioner")).toBeVisible({timeout: 10_000});
      await expect(page.locator("#book-practitioner option", {hasText: "Jane Smith, DVM"})).toHaveCount(1);
      const bookPageText = await page.locator("body").innerText();
      expect(bookPageText).not.toContain(ACCREDITATION_NUMBER);
    } finally {
      const client = await mongo();
      await client.db().collection("bookingsettings").updateMany({}, {$set: {schedulingMode: "clinic"}});
      await client.close();
    }
  });

  test("the vet signs in and edits their own title via My profile - self-service, scoped to their own row", async ({page}) => {
    await page.context().clearCookies();
    await devLogin(page, VET_EMAIL);
    await page.goto("/settings");

    const myProfile = myProfileCard(page);
    await expect(myProfile).toBeVisible();
    // The owner's earlier edits already populate this card - it is the SAME underlying row.
    await expect(myProfile.getByLabel("First name")).toHaveValue("Jane");
    await expect(myProfile.getByLabel("Last name")).toHaveValue("Smith");
    await expect(myProfile.getByLabel("Title / qualification")).toHaveValue("DVM");
    await expect(myProfile.getByLabel("Government accreditation number")).toHaveValue(ACCREDITATION_NUMBER);

    await myProfile.getByLabel("Title / qualification").fill("DVM, DACVIM");
    await Promise.all([
      page.waitForResponse((res) => res.url().includes("/api/settings/staff/me/profile") && res.request().method() === "PATCH"),
      myProfile.getByRole("button", {name: "Save"}).click(),
    ]);
    await expect(page.getByText("Profile saved")).toBeVisible({timeout: 10_000});

    // Deterministic proof this actually wrote the caller's own row (never trusting the client-side
    // render alone): the roster's own list API, re-fetched fresh.
    const staffList = (await (await page.request.get("/api/settings/staff")).json()) as Array<{
      email: string;
      firstName?: string;
      lastName?: string;
      title?: string;
      accreditationNumber?: string;
    }>;
    const self = staffList.find((s) => s.email === VET_EMAIL);
    expect(self?.firstName).toBe("Jane");
    expect(self?.lastName).toBe("Smith");
    expect(self?.title).toBe("DVM, DACVIM");
    expect(self?.accreditationNumber).toBe(ACCREDITATION_NUMBER);

    // A full reload unifies MyProfileSection's own edit with the (read-only, for this non-owner
    // session) Practitioner profiles card, which shares the exact same composition function.
    await page.reload();
    await expect(practitionerCard(page, VET_EMAIL).getByText("Jane Smith, DVM, DACVIM", {exact: true})).toBeVisible();
  });

  test("a legacy displayName-only row shows the 'currently shown as' hint; Clear legacy name falls back to the email tier", async ({page}) => {
    const client = await mongo();
    await client.db().collection("staffs").insertOne({
      staffId: randomUUID(),
      email: LEGACY_VET_EMAIL,
      role: "vet",
      disabled: false,
      bookable: true,
      displayName: "Dr. Legacy Vet",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await client.close();

    await devLogin(page, "owner@example.com");
    await page.goto("/settings");

    const card = practitionerCard(page, LEGACY_VET_EMAIL);
    await expect(card.getByText("Dr. Legacy Vet", {exact: true})).toBeVisible();
    await expect(card.getByText('Currently shown as "Dr. Legacy Vet" (legacy display name)')).toBeVisible();

    await Promise.all([
      page.waitForResponse((res) => isStaffPatch(res.url()) && res.request().method() === "PATCH"),
      card.getByRole("button", {name: "Clear legacy name"}).click(),
    ]);

    const cardAfterClear = practitionerCard(page, LEGACY_VET_EMAIL);
    await expect(cardAfterClear.getByText("legacy display name")).toHaveCount(0);
    // Tier 3 (email local part) is what is left once the deprecated tier-2 displayName is cleared
    // and no first/last name was ever entered - the same fallback e2e/practitioner-mode.spec.ts
    // and e2e/vet-wallet-status.spec.ts depend on for THEIR OWN unnamed vets.
    await expect(cardAfterClear.getByText(LEGACY_VET_EMAIL.split("@")[0]!, {exact: true})).toBeVisible();
  });
});
