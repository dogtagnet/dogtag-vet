import {expect, test, type Page} from "@playwright/test";

/**
 * End-to-end coverage for plans/wp4.5-track12-plan.md issue 1: the calendar's service dropdown
 * looked broken with zero services in the DB (one lone "No specific service" option, no
 * affordance). Covers the new empty-state hint in CreateAppointmentPanel, the active-only filter
 * it sits behind, and the bookableOnline hazard the ServiceForm helper text now warns about.
 *
 * Shares the one seeded DB with every other spec (workers: 1, alphabetical file order) - the
 * seeded "General checkup" service must come out of this file exactly as it went in
 * (active + bookable), since smoke.spec.ts's availability assertion and mobile-booking.spec.ts
 * both depend on it. A single `afterEach` restores BOTH "General checkup" and this file's own
 * "Dental cleaning" fixture to their baseline state after every test, pass or fail, rather than
 * relying on trailing cleanup lines a failed assertion would skip.
 */

const SHOTS_DIR = "/private/tmp/claude-501/-Users-zhenhaowu-code-dogtag/85e989bd-eec1-4250-ab09-83fb3244d856/scratchpad/wp45-shots";

interface ServiceSummary {
  serviceId: string;
  name: string;
  active: boolean;
  bookableOnline: boolean;
}

async function signInAsStaff(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByRole("button", {name: "Dev sign in (test only)"}).click();
  // 15s, not the 5s default - see appointment-tagging.spec.ts's signInAsStaff for why (cold `next
  // dev` first-compile block on the post-sign-in navigation).
  await expect(page).toHaveURL(/\/dashboard$/, {timeout: 15_000});
}

/** `YYYY-MM-DD` for a day this many days from now - each calendar-UI test uses its own so
 * appointments/services from different tests never interact through the same grid cell. */
function futureDate(daysFromNow: number): string {
  const d = new Date(Date.now() + daysFromNow * 86_400_000);
  return d.toISOString().slice(0, 10);
}

async function openCreateDialogOnEmptySlot(page: Page, date: string) {
  await page.goto(`/calendar?date=${date}&view=day`);
  await page.getByRole("button", {name: new RegExp(`^New appointment ${date}`)}).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

async function setTheme(page: Page, theme: "Light" | "Dark") {
  await page.getByRole("radio", {name: theme}).click();
  await expect(page.getByRole("radio", {name: theme})).toHaveAttribute("aria-checked", "true");
  if (theme === "Dark") await expect(page.locator("html")).toHaveClass(/dark/);
  else await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

async function listServices(page: Page): Promise<ServiceSummary[]> {
  const res = await page.request.get("/api/services");
  expect(res.ok()).toBe(true);
  return res.json();
}

async function patchService(page: Page, serviceId: string, patch: Partial<{active: boolean; bookableOnline: boolean}>) {
  const res = await page.request.patch(`/api/services/${serviceId}`, {data: patch});
  expect(res.ok()).toBe(true);
}

/** Deactivates every currently-active service (whatever they are - never hardcodes which ones,
 * since an earlier test in this file may have already added its own fixture) and returns their
 * ids, so a caller can reactivate exactly what it turned off. */
async function deactivateAllActive(page: Page): Promise<string[]> {
  const services = await listServices(page);
  const activeIds = services.filter((s) => s.active).map((s) => s.serviceId);
  await Promise.all(activeIds.map((id) => patchService(page, id, {active: false})));
  return activeIds;
}

/** Restores the two known fixtures this file depends on to their baseline shape, by name (not by
 * a tracked id) so it works no matter which test just ran or whether "Dental cleaning" exists yet.
 * "General checkup" must leave this file active+bookable for smoke.spec.ts and
 * mobile-booking.spec.ts, which both run later in the alphabetical suite order. */
async function restoreBaseline(page: Page) {
  const services = await listServices(page);
  for (const s of services) {
    if (s.name === "General checkup" && (!s.active || !s.bookableOnline)) {
      await patchService(page, s.serviceId, {active: true, bookableOnline: true});
    }
    if (s.name === "Dental cleaning" && (!s.active || s.bookableOnline)) {
      await patchService(page, s.serviceId, {active: true, bookableOnline: false});
    }
  }
}

test.describe.serial("calendar service dropdown (WP4.5 issue 1)", () => {
  test.beforeEach(async ({page}) => {
    await signInAsStaff(page);
  });

  test.afterEach(async ({page}) => {
    await restoreBaseline(page);
  });

  test("1. creating a service via /services/new makes it selectable on the calendar and tags the appointment", async ({page}) => {
    // Generous, not the 30s default: this is the very first hit on /services/new, /calendar, AND
    // /appointments/[id] when this spec runs in isolation (each a separate on-demand dev-mode
    // compile) - see appointment-tagging.spec.ts's signInAsStaff for the same class of cold-start
    // slowness. In the full suite, appointment-tagging.spec.ts (alphabetically first) has already
    // warmed /calendar and /appointments/[id]; this only needs to absorb /services/new's own.
    test.setTimeout(60_000);
    await page.goto("/services/new");
    await page.getByLabel("Name").fill("Dental cleaning");
    await page.getByLabel("Duration (minutes)").fill("45");
    // Active and Bookable online are left at their form defaults (checked / unchecked) -
    // deliberately exercising the defaults the previous commit's serviceSchema test documents.
    await page.getByRole("button", {name: "Create service"}).click();
    // Generous, not the 5s default - see booking-config-timezone.spec.ts's identical note on its
    // own save-snackbar assertion (observed flaking under full-suite system load).
    await expect(page.getByText("Service created")).toBeVisible({timeout: 10_000});
    // Also generous: the router.push redirect this snackbar accompanies lands on /services/[id],
    // never visited earlier in this run - its first on-demand dev-mode compile stacks on top of
    // the same system load, and was observed missing the 5s default here specifically (the
    // snackbar itself was already up) - the same class of cold-navigation slowness
    // appointment-tagging.spec.ts's own post-click navigations already budget 15s for.
    await expect(page).toHaveURL(/\/services\/[0-9a-f-]+$/, {timeout: 15_000});
    const serviceId = new URL(page.url()).pathname.split("/").filter(Boolean).pop()!;

    const date = futureDate(60);
    await openCreateDialogOnEmptySlot(page, date);
    await expect(page.getByLabel("Service")).toBeVisible();
    // Also proves the empty-state hint from this fix is gone now that a service exists.
    await expect(page.getByText("No active services yet.")).not.toBeVisible();
    await page.getByLabel("Service").selectOption({label: "Dental cleaning (45 min)"});

    await page.getByRole("checkbox", {name: "Walk-in (no client record)"}).check();
    await page.getByPlaceholder("Client name").fill("Dental Walk-in E2E");
    await page.getByPlaceholder("Pet name").fill("Dental Pet E2E");
    await page.getByRole("button", {name: "Create"}).click();
    await expect(page.getByText("Appointment created")).toBeVisible({timeout: 10_000});

    // Generous too: the chip's appearance depends on onCreated's router.refresh() (a fresh server
    // round trip re-rendering CalendarView), the same load-sensitive mechanism as the two waits
    // above, not just local client state.
    const chip = page.getByRole("button", {name: /Dental Walk-in E2E - Dental Pet E2E/});
    await expect(chip).toBeVisible({timeout: 10_000});
    await chip.click();
    await expect(page).toHaveURL(/\/appointments\/[0-9a-f-]+$/, {timeout: 15_000});
    const appointmentId = new URL(page.url()).pathname.split("/").filter(Boolean).pop()!;

    const appointmentRes = await page.request.get(`/api/appointments/${appointmentId}`);
    expect(appointmentRes.ok()).toBe(true);
    const appointment = await appointmentRes.json();
    expect(appointment.serviceId).toBe(serviceId);
    expect(appointment.endAt - appointment.startAt).toBe(2700); // 45 min

    const serviceRow = page.locator("dl > div", {has: page.getByText("Service", {exact: true})});
    await expect(serviceRow).toContainText("Dental cleaning");
  });

  test("2. deactivating a service removes it from the calendar dropdown but keeps it listed on /services", async ({page}) => {
    const services = await listServices(page);
    const dentalCleaning = services.find((s) => s.name === "Dental cleaning");
    if (!dentalCleaning) throw new Error("Dental cleaning fixture from test 1 is missing");

    await patchService(page, dentalCleaning.serviceId, {active: false});

    const date = futureDate(61);
    await openCreateDialogOnEmptySlot(page, date);
    await expect(page.getByLabel("Service").locator("option", {hasText: "Dental cleaning"})).toHaveCount(0);
    await expect(page.getByLabel("Service").locator("option", {hasText: "General checkup"})).toHaveCount(1);
    await page.getByRole("button", {name: "Cancel"}).click();

    await page.goto("/services");
    const row = page.locator("tr", {has: page.getByRole("link", {name: "Dental cleaning"})});
    await expect(row.getByText("Inactive", {exact: true})).toBeVisible();
  });

  test("3. every service inactive shows the empty-state hint, which links to /services/new", async ({page}) => {
    await deactivateAllActive(page);

    const date = futureDate(62);
    await openCreateDialogOnEmptySlot(page, date);
    await expect(page.getByLabel("Service").locator("option")).toHaveCount(1); // "No specific service" only
    await expect(page.getByText("No active services yet.")).toBeVisible();
    const link = page.getByRole("dialog").getByRole("link", {name: "Create one under Services"});
    await expect(link).toHaveAttribute("href", "/services/new");
    await link.click();
    await expect(page).toHaveURL(/\/services\/new$/);
  });

  test("4. bookableOnline hazard: a defaults-created service is invisible to public booking until switched on", async ({page}) => {
    const baseline = await listServices(page);
    const generalCheckup = baseline.find((s) => s.name === "General checkup");
    const dentalCleaning = baseline.find((s) => s.name === "Dental cleaning");
    if (!generalCheckup || !dentalCleaning) throw new Error("expected fixtures missing");

    // Temporarily take the seeded service off bookableOnline too, so the public surfaces'
    // "nothing bookable" state is unambiguous rather than merely "one of two" services missing.
    await patchService(page, generalCheckup.serviceId, {bookableOnline: false});

    const date = futureDate(63);
    await openCreateDialogOnEmptySlot(page, date);
    // The staff dialog's active-only filter doesn't care about bookableOnline at all.
    await expect(page.getByLabel("Service").locator("option", {hasText: "Dental cleaning"})).toHaveCount(1);
    await page.getByRole("button", {name: "Cancel"}).click();

    const before = await page.request.get("/v1/booking/services");
    expect(await before.json()).toEqual([]);
    await page.goto("/book");
    await expect(page.getByText("This clinic is not accepting online bookings right now.")).toBeVisible();

    await patchService(page, dentalCleaning.serviceId, {bookableOnline: true});

    const after = await page.request.get("/v1/booking/services");
    const afterList = await after.json();
    expect(afterList.map((s: {name: string}) => s.name)).toEqual(["Dental cleaning"]);
    await page.goto("/book");
    await expect(page.getByLabel("Service")).toContainText("Dental cleaning");
  });

  test("5. screenshots (both themes): calendar dialog empty-service-dropdown state", async ({page}) => {
    await deactivateAllActive(page);
    const date = futureDate(64);
    for (const theme of ["Light", "Dark"] as const) {
      await page.goto(`/calendar?date=${date}&view=day`);
      await setTheme(page, theme);
      await page.getByRole("button", {name: new RegExp(`^New appointment ${date}`)}).first().click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByText("No active services yet.")).toBeVisible();
      await page.screenshot({path: `${SHOTS_DIR}/dialog-empty-services-${theme.toLowerCase()}.png`});
      await page.getByRole("button", {name: "Cancel"}).click();
    }
  });
});
