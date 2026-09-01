import {expect, test, type APIResponse, type Page} from "@playwright/test";

/**
 * End-to-end coverage for plans/wp4.5-track12-plan.md issue 2: BookingConfigSection's plain text
 * Input let any junk store as the clinic's timezone (bookingSettingsSchema was z.string().min(1)),
 * silently 500-ing /calendar and /dashboard SSR (todayInTimeZone) or vanishing every booking slot
 * (date-fns-tz's fromZonedTime returning Invalid Date). Covers the new TimezonePicker end to end:
 * mouse and keyboard-only selection, an invalid zone being impossible to select or save, the
 * server rejecting a direct API attempt too, and that changing the zone actually shifts which UTC
 * instants /v1/booking/availability returns.
 *
 * Shares the one seeded DB with every other spec (workers: 1, alphabetical file order - this file
 * runs right after appointment-tagging.spec.ts and before calendar-services/mobile-booking/smoke).
 * A single `afterEach` restores the seeded "America/New_York" after every test regardless of
 * pass/fail, since nothing here should leak a different clinic timezone into the rest of the run.
 */

const SHOTS_DIR = "/private/tmp/claude-501/-Users-zhenhaowu-code-dogtag/85e989bd-eec1-4250-ab09-83fb3244d856/scratchpad/wp45-shots";

interface DateParts {
  y: number;
  m: number;
  d: number;
}

interface BookingSettings {
  timezone: string;
  minNoticeMinutes: number;
  maxAdvanceDays: number;
  slotGranularityMinutes: number;
}

async function signInAsStaff(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByRole("button", {name: "Dev sign in (test only)"}).click();
  await expect(page).toHaveURL(/\/dashboard$/, {timeout: 15_000});
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

/** "UTC±HH:MM" for `zone` at `at`, independently of src/lib/timezones.ts (this spec exercises the
 * app as a black box, like every other e2e spec here) - via the same standard `Intl` primitive,
 * used only to compute THIS TEST's expected value, not to re-exercise the app's own logic. */
function offsetLabel(zone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {timeZone: zone, timeZoneName: "longOffset"}).formatToParts(at);
  const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  const label = raw.replace("GMT", "UTC");
  return label === "UTC" ? "UTC+00:00" : label;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function addDays(date: DateParts, days: number): DateParts {
  const d = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return {y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate()};
}

/** Next calendar date (UTC-anchored Y/M/D - calendar weekday never depends on timezone, matching
 * dst.ts's own dayOfWeekForDateStr) on weekday `targetDow` (0=Sun..6=Sat) at least `minDaysOut`
 * days out - comfortably clear of minNoticeMinutes and any "today is a partial day" edge. */
function nextWeekdayAtLeast(targetDow: number, minDaysOut: number): DateParts {
  const start = new Date(Date.now() + minDaysOut * 86_400_000);
  let candidate: DateParts = {y: start.getUTCFullYear(), m: start.getUTCMonth() + 1, d: start.getUTCDate()};
  while (new Date(Date.UTC(candidate.y, candidate.m - 1, candidate.d)).getUTCDay() !== targetDow) {
    candidate = addDays(candidate, 1);
  }
  return candidate;
}

function isoAtUtc(date: DateParts, hour: number): string {
  return new Date(Date.UTC(date.y, date.m - 1, date.d, hour, 0, 0)).toISOString();
}

/** Independent (from dst.ts) UTC epoch-ms for a clinic-local wall-clock reading, via Intl's own
 * offset formatting - this test's own expectation, not a second exercise of the app's conversion. */
function localWallClockToUtcMs(date: DateParts, hour: number, minute: number, zone: string): number {
  const asIfUtcMs = Date.UTC(date.y, date.m - 1, date.d, hour, minute, 0);
  const raw = offsetLabel(zone, new Date(asIfUtcMs)); // "UTC-08:00"
  const match = /UTC([+-])(\d{2}):(\d{2})/.exec(raw);
  if (!match || !match[1] || !match[2] || !match[3]) throw new Error(`Could not parse offset from "${raw}"`);
  const sign = match[1] === "-" ? -1 : 1;
  const offsetMs = sign * (Number(match[2]) * 3_600_000 + Number(match[3]) * 60_000);
  return asIfUtcMs - offsetMs;
}

async function getSettings(page: Page): Promise<BookingSettings> {
  const res = await page.request.get("/api/availability/settings");
  expect(res.ok()).toBe(true);
  return res.json();
}

/** PATCHes booking settings, filling in the other three required fields from the CURRENT stored
 * values (bookingSettingsSchema takes the full object, not a partial) so callers only need to
 * name the field they actually care about changing. */
async function patchSettings(page: Page, patch: Partial<BookingSettings>): Promise<APIResponse> {
  const current = await getSettings(page);
  return page.request.patch("/api/availability/settings", {data: {...current, ...patch}});
}

test.describe.serial("booking configuration timezone picker (WP4.5 issue 2)", () => {
  test.beforeEach(async ({page}) => {
    await signInAsStaff(page);
  });

  test.afterEach(async ({page}) => {
    // The seeded default - nothing in this file (or anything depending on it later in the
    // alphabetical run: calendar-services, mobile-booking, smoke) should see any other zone.
    const res = await patchSettings(page, {timezone: "America/New_York"});
    expect(res.ok()).toBe(true);
  });

  test("1. removing the chip and clicking a searched zone selects it, and Save persists it", async ({page}) => {
    const now = new Date();
    await page.goto("/settings");

    await expect(page.getByText("America/New_York", {exact: true})).toBeVisible();
    await expect(page.getByText(offsetLabel("America/New_York", now))).toBeVisible();

    await page.getByRole("button", {name: "Remove America/New_York"}).click();
    const combobox = page.getByRole("combobox", {name: "Timezone"});
    await expect(combobox).toBeVisible();

    await combobox.fill("los ang");
    const option = page.getByRole("option").filter({hasText: "America/Los_Angeles"});
    await expect(option).toBeVisible();
    await expect(option).toContainText(offsetLabel("America/Los_Angeles", now));
    await option.click();

    await expect(page.getByText("America/Los_Angeles", {exact: true})).toBeVisible();
    await page.getByRole("button", {name: "Save booking configuration"}).click();
    await expect(page.getByText("Booking settings saved")).toBeVisible();

    const settings = await getSettings(page);
    expect(settings.timezone).toBe("America/Los_Angeles");
  });

  test("2. keyboard-only: type, ArrowDown, Enter selects; Escape closes without selecting", async ({page}) => {
    await page.goto("/settings");
    await page.getByRole("button", {name: /^Remove /}).click();

    const combobox = page.getByRole("combobox", {name: "Timezone"});
    await combobox.fill("tokyo");
    const tokyoOption = page.getByRole("option").filter({hasText: "Asia/Tokyo"});
    await expect(tokyoOption).toBeVisible();
    await combobox.press("ArrowDown");
    await expect(tokyoOption).toHaveAttribute("aria-selected", "true");
    await combobox.press("Enter");
    await expect(page.getByText("Asia/Tokyo", {exact: true})).toBeVisible();

    await page.getByRole("button", {name: "Remove Asia/Tokyo"}).click();
    const combobox2 = page.getByRole("combobox", {name: "Timezone"});
    await combobox2.fill("berlin");
    await expect(page.getByRole("option").filter({hasText: "Europe/Berlin"})).toBeVisible();
    await combobox2.press("Escape");
    await expect(page.getByRole("listbox")).not.toBeVisible();
    await expect(page.getByText("Europe/Berlin", {exact: true})).not.toBeVisible();
    await expect(combobox2).toHaveValue("berlin"); // Escape closes but the typed query stays, per Combobox's own contract
  });

  test("3. an invalid zone can't be selected or saved, and the server refuses it directly too", async ({page}) => {
    await page.goto("/settings");
    await page.getByRole("button", {name: /^Remove /}).click();

    const combobox = page.getByRole("combobox", {name: "Timezone"});
    await combobox.fill("NotAZone");
    await expect(page.getByText("No matching timezones")).toBeVisible();
    await combobox.press("Enter"); // zero options -> activeIndex never advances past -1, so this is a no-op
    await expect(page.getByRole("listbox")).not.toBeVisible();
    // Still the bare combobox, not a chip - Enter selected nothing, so there is nothing to show.
    await expect(combobox).toHaveValue("NotAZone");

    await page.getByRole("button", {name: "Save booking configuration"}).click();
    await expect(page.getByText("Choose a timezone before saving")).toBeVisible();

    const settings = await getSettings(page);
    expect(settings.timezone).toBe("America/New_York"); // unchanged - the previous test's afterEach restored it

    const badPatch = await patchSettings(page, {timezone: "America/NewYork"});
    expect(badPatch.status()).toBe(400);
  });

  test("4. changing the zone shifts which UTC instants are offered, and /calendar and /book keep working", async ({page}) => {
    test.setTimeout(60_000); // first hit on /book in this run - see calendar-services.spec.ts's same note
    const setRes = await patchSettings(page, {timezone: "America/Los_Angeles"});
    expect(setRes.ok()).toBe(true);

    // A guaranteed-open weekday (seed: Mon-Fri) at least 10 days out, bracketed so slots[0]
    // unambiguously means "that Monday's opening slot" regardless of which zone is active. `from`
    // is noon UTC on the preceding Saturday, not midnight: Friday's own LATE local slots can spill
    // into "Saturday" by UTC-calendar-date for any zone behind UTC (e.g. Friday 16:30 PST is
    // 2026-01-17T00:30:00Z, already Saturday in UTC terms) - midnight UTC would wrongly capture
    // that trailing Friday slot as slots[0] instead of Monday's. Noon UTC is comfortably after any
    // such spillover and comfortably before Monday's opening in any plausible US zone.
    const monday = nextWeekdayAtLeast(1, 10);
    const from = isoAtUtc(addDays(monday, -2), 12);
    const to = isoAtUtc(addDays(monday, 1), 0);

    const servicesRes = await page.request.get("/v1/booking/services");
    const serviceList = await servicesRes.json();
    const service = serviceList.find((s: {name: string}) => s.name === "General checkup");
    expect(service).toBeTruthy();

    const availabilityRes = await page.request.get(`/v1/booking/availability?serviceId=${service.id}&from=${from}&to=${to}`);
    expect(availabilityRes.ok()).toBe(true);
    const availability = await availabilityRes.json();
    expect(availability.slots.length).toBeGreaterThan(0);

    const expectedUtcMs = localWallClockToUtcMs(monday, 9, 0, "America/Los_Angeles");
    expect(Date.parse(availability.slots[0].startAt)).toBe(expectedUtcMs);

    await page.goto("/calendar");
    await expect(page.getByRole("heading", {name: "Calendar"})).toBeVisible();

    await page.goto("/book");
    await page.getByLabel("Date").fill(`${monday.y}-${pad2(monday.m)}-${pad2(monday.d)}`);
    await page.getByRole("button", {name: "Check availability"}).click();
    await expect(page.locator("p:has-text('Open times') + div button").first()).toBeVisible();
  });

  test("5. screenshots (both themes): the open timezone combobox with offsets", async ({page}) => {
    for (const theme of ["Light", "Dark"] as const) {
      await page.goto("/settings");
      await setTheme(page, theme);
      await page.getByRole("button", {name: /^Remove /}).click();
      const combobox = page.getByRole("combobox", {name: "Timezone"});
      await combobox.fill("new"); // a small, clean result set: America/New_York + .../New_Salem
      await expect(page.getByRole("listbox")).toBeVisible();
      await page.screenshot({path: `${SHOTS_DIR}/timezone-combobox-open-${theme.toLowerCase()}.png`});
    }
  });
});
