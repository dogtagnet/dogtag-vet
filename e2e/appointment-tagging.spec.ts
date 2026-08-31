import {expect, test, type Page} from "@playwright/test";

/**
 * End-to-end coverage for plans/wp4.3-appointment-tagging-client-id.md: tagging an appointment to
 * one client and N pets via the accessible pickers, disambiguating same-named clients, the
 * calendar chip-click fix, the appointment detail page's status actions and Edit-tagging section,
 * the walk-in fallback, client identification fields, and a public-booking regression check.
 *
 * Own fixtures created via the API (per the repo's mongo-fixture pattern - the seed has no
 * clients/pets), and each calendar-UI test uses its own far-future date so appointments from
 * different tests never share a grid cell.
 */

const SHOTS_DIR = "/private/tmp/claude-501/-Users-zhenhaowu-code-dogtag/85e989bd-eec1-4250-ab09-83fb3244d856/scratchpad/wp43-shots";

async function signInAsStaff(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByRole("button", {name: "Dev sign in (test only)"}).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

interface CreatedClient {
  clientId: string;
  name: string;
  email: string;
  phone: string;
}

async function createClient(
  page: Page,
  fields: {name: string; email: string; phone: string; idDocType?: string; idDocNumber?: string},
): Promise<CreatedClient> {
  const res = await page.request.post("/api/clients", {data: fields});
  expect(res.ok()).toBe(true);
  const body = await res.json();
  return {clientId: body.clientId, name: fields.name, email: fields.email, phone: fields.phone};
}

async function createPet(page: Page, name: string, ownerClientIds: string[]): Promise<string> {
  const res = await page.request.post("/api/pets", {data: {name, ownerClientIds}});
  expect(res.ok()).toBe(true);
  const body = await res.json();
  return body.petId as string;
}

/** Creates a tagged or walk-in appointment directly via the API - used by tests that exercise the
 * detail page / list page / status actions without needing to drive the calendar UI first. */
async function createAppointmentApi(
  page: Page,
  fields: {clientId?: string; petIds?: string[]; clientName?: string; petName?: string; startAt: number},
): Promise<string> {
  const res = await page.request.post("/api/appointments", {
    data: {
      source: "staff",
      startAt: fields.startAt,
      endAt: fields.startAt + 1800,
      ...(fields.clientId
        ? {clientId: fields.clientId, petIds: fields.petIds}
        : {clientName: fields.clientName, petName: fields.petName}),
    },
  });
  expect(res.ok()).toBe(true);
  const body = await res.json();
  return body.appointmentId as string;
}

async function getAppointment(page: Page, appointmentId: string) {
  const res = await page.request.get(`/api/appointments/${appointmentId}`);
  expect(res.ok()).toBe(true);
  return res.json();
}

/** `YYYY-MM-DD` for a day this many days from now (UTC-based - only needs to be a distinct future
 * date, not timezone-exact) - each calendar-UI test uses its own so appointments from different
 * tests never land in the same day's grid. */
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
  // The DOM class updates synchronously with the click (confirmed above), but a screenshot taken
  // immediately after can still capture a frame from BEFORE Chromium repaints to reflect it -
  // asserting on DOM state proves the class is right, not that a new frame has been composited.
  // Two rAFs is the standard "wait for a full paint to actually land" technique.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

test.beforeEach(async ({page}) => {
  await signInAsStaff(page);
});

/**
 * The full journey (WP4.3 section E), chained as one continuous story through `describe.serial`
 * so "retag to the other John" is literally the SAME two clients the disambiguation step created -
 * each step still reports pass/fail individually (serial mode only skips what comes AFTER a
 * failure, it doesn't merge them into one opaque test), but state (the two clients, the pets, the
 * one appointment) flows forward exactly like a single staff member's real session would.
 */
test.describe.serial("two Johns: tag with disambiguation, navigate, retag, untag, status action", () => {
  let johnA: CreatedClient;
  let johnB: CreatedClient;
  let appointmentId: string;
  const date = futureDate(30);

  test("calendar create dialog: disambiguates two same-named clients by email/phone, tags two pets", async ({page}) => {
    johnA = await createClient(page, {name: "John Carter", email: "john.carter.a@example.com", phone: "555-0101"});
    johnB = await createClient(page, {name: "John Carter", email: "john.carter.b@example.com", phone: "555-0102"});
    // "create pets for one" (WP4.3 E) - only John A gets pets up front; John B gets one later, at
    // the point the retag step actually needs it to complete a valid retag.
    await createPet(page, "Rex", [johnA.clientId]);
    await createPet(page, "Fido", [johnA.clientId]);

    await openCreateDialogOnEmptySlot(page, date);

    // Tagged mode is the default - no walk-in free-text inputs, the pickers are what's shown.
    await expect(page.getByRole("checkbox", {name: "Walk-in (no client record)"})).not.toBeChecked();
    const clientCombobox = page.getByRole("combobox", {name: "Search clients"});
    await expect(clientCombobox).toBeVisible();

    await clientCombobox.fill("John Carter");
    // Disambiguation: BOTH same-named clients show up, each tellable apart by email.
    const optionA = page.getByRole("option").filter({hasText: johnA.email});
    const optionB = page.getByRole("option").filter({hasText: johnB.email});
    await expect(optionA).toBeVisible();
    await expect(optionB).toBeVisible();
    await expect(optionA).toContainText(johnA.phone);
    await optionA.click();

    // Selecting collapses the combobox into a chip carrying the email - proof the RIGHT John was tagged.
    await expect(page.getByText(` - ${johnA.email}`)).toBeVisible();

    const petCombobox = page.getByRole("combobox", {name: "Search pets"});
    await expect(petCombobox).toBeEnabled();
    await petCombobox.click();
    await page.getByRole("option", {name: /^Rex/}).click();
    // Keyboard nav for the second pick (ArrowDown + Enter, WP4.3 B3's combobox a11y requirement) -
    // also sidesteps that selecting Rex left focus on this same input (by design, so a multi-select
    // picker can accept another pick right away), so a plain second click here would just be
    // re-exercising Combobox's own onClick reopen rather than the keyboard path.
    await petCombobox.press("ArrowDown");
    await expect(page.getByRole("option", {name: /^Fido/})).toHaveAttribute("aria-selected", "true");
    await petCombobox.press("Enter");
    await expect(page.getByRole("button", {name: "Remove Rex"})).toBeVisible();
    await expect(page.getByRole("button", {name: "Remove Fido"})).toBeVisible();

    await page.getByRole("button", {name: "Create"}).click();
    await expect(page.getByText("Appointment created")).toBeVisible();

    const chip = page.getByRole("button", {name: /John Carter - (Rex, Fido|Fido, Rex)/});
    await expect(chip).toBeVisible();

    // Chip click navigates to the detail page - it must NOT reopen the create dialog (WP4.3 C7).
    // This is the FIRST navigation to /appointments/[id] in a freshly-started dev server for the
    // whole suite - Next.js dev mode compiles routes on demand, and that first compile can
    // occasionally take longer than the default 5s assertion budget (the same class of "known-slow
    // first real step" wallet-registration.spec.ts already extends timeouts for).
    await chip.click();
    await expect(page).toHaveURL(/\/appointments\/[0-9a-f-]+$/, {timeout: 15_000});
    appointmentId = new URL(page.url()).pathname.split("/").filter(Boolean).pop()!;
    await expect(page.getByRole("link", {name: "John Carter"})).toBeVisible();
    await expect(page.getByRole("link", {name: "Rex"})).toBeVisible();
    await expect(page.getByRole("link", {name: "Fido"})).toBeVisible();
  });

  test("appointments list: the When link opens the same appointment's detail page", async ({page}) => {
    await page.goto("/appointments");
    // Located by its own href, not by name text - "John Carter" is deliberately not unique (two
    // clients share it), so this is the same unambiguous approach the app's own links use.
    const row = page.locator("tr", {has: page.locator(`a[href="/appointments/${appointmentId}"]`)});
    await expect(row).toBeVisible();
    await expect(row.getByRole("link", {name: "John Carter"})).toBeVisible(); // client cell also links
    await row.locator(`a[href="/appointments/${appointmentId}"]`).click(); // the When cell's own link
    await expect(page).toHaveURL(new RegExp(`/appointments/${appointmentId}$`));
  });

  test("retag to the other John: stale pets clear in the picker, and the server refuses them if sent directly", async ({page}) => {
    const miloId = await createPet(page, "Milo", [johnB.clientId]);

    await page.goto(`/appointments/${appointmentId}`);
    await expect(page.getByRole("heading", {name: "Edit tagging"})).toBeVisible();
    await expect(page.getByRole("button", {name: "Remove Rex"})).toBeVisible();
    await expect(page.getByRole("button", {name: "Remove Fido"})).toBeVisible();

    const editSection = page.locator("section", {has: page.getByRole("heading", {name: "Edit tagging"})});
    // Both Johns share this label - unambiguous here since only the CURRENTLY-tagged one (A) has
    // a rendered chip to remove at this point.
    await editSection.getByRole("button", {name: "Remove John Carter"}).click();
    await editSection.getByRole("combobox", {name: "Search clients"}).fill("John Carter");
    const optionB = page.getByRole("option").filter({hasText: johnB.email});
    await expect(optionB).toBeVisible();
    await optionB.click();

    // The stale pets (Rex, Fido - owned by John A) are cleared automatically now that the tagged
    // client changed to John B.
    await expect(page.getByRole("button", {name: "Remove Rex"})).not.toBeVisible();
    await expect(page.getByRole("button", {name: "Remove Fido"})).not.toBeVisible();
    await expect(editSection.getByRole("button", {name: "Save tagging"})).toBeDisabled();

    await editSection.getByRole("combobox", {name: "Search pets"}).click();
    await page.getByRole("option", {name: /^Milo/}).click();
    await editSection.getByRole("button", {name: "Save tagging"}).click();
    await expect(page.getByText("Tagging saved")).toBeVisible();

    const afterRetag = await getAppointment(page, appointmentId);
    expect(afterRetag.clientId).toBe(johnB.clientId);
    expect(afterRetag.petIds).toEqual([miloId]);
    expect(afterRetag.clientName).toBe("John Carter");
    expect(afterRetag.petName).toBe("Milo");

    // Adversarial probe: a direct API request that retags back to John A while keeping Milo (John
    // B's pet, never John A's) is refused.
    const badPatch = await page.request.patch(`/api/appointments/${appointmentId}`, {
      data: {clientId: johnA.clientId, petIds: [miloId]},
    });
    expect(badPatch.status()).toBe(400);
  });

  test("untag: clears the link but freezes the display names rather than blanking them", async ({page}) => {
    // WP4.3 accuracy criterion "untag clears names correctly" - the PATCH surface has no slot for
    // new free text on untag, so clientName/petName freeze at their last tagged values instead of
    // blanking (they stay required, non-blank end to end); what actually clears is the LINK, since
    // every "is this tagged?" render decision keys off clientId/petIds, never name truthiness.
    await page.goto(`/appointments/${appointmentId}`);
    const editSection = page.locator("section", {has: page.getByRole("heading", {name: "Edit tagging"})});
    await editSection.getByRole("button", {name: "Remove John Carter"}).click();
    await editSection.getByRole("button", {name: "Save tagging"}).click();
    await expect(page.getByText("Tagging saved")).toBeVisible();

    const afterUntag = await getAppointment(page, appointmentId);
    expect(afterUntag.clientId).toBeUndefined();
    expect(afterUntag.petIds).toEqual([]);
    expect(afterUntag.clientName).toBe("John Carter"); // frozen, not blanked
    expect(afterUntag.petName).toBe("Milo"); // frozen, not blanked

    await page.reload();
    await expect(page.getByText("(walk-in - no client record)")).toBeVisible();
    await expect(page.getByRole("link", {name: "John Carter"})).not.toBeVisible();
    await expect(page.getByRole("link", {name: "Milo"})).not.toBeVisible();
  });

  test("status action: Confirm moves this appointment from scheduled to confirmed", async ({page}) => {
    await page.goto(`/appointments/${appointmentId}`);
    await expect(page.getByText("Scheduled", {exact: true})).toBeVisible();
    await page.getByRole("button", {name: "Confirm"}).click();
    await expect(page.getByText("appointment confirmed")).toBeVisible();
    await expect(page.getByText("Confirmed", {exact: true})).toBeVisible();

    const updated = await getAppointment(page, appointmentId);
    expect(updated.status).toBe("confirmed");
  });
});

test("open slot still creates after the chip-click fix (regression, on a day with no appointments)", async ({page}) => {
  const date = futureDate(31);
  await openCreateDialogOnEmptySlot(page, date);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", {name: "Cancel"}).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("client identification fields round-trip through the form", async ({page}) => {
  const client = await createClient(page, {name: "ID Fields Client", email: "id-fields@example.com", phone: "555-0401"});
  await page.goto(`/clients/${client.clientId}`);

  await page.getByLabel("Document type").selectOption("passport");
  await page.getByLabel("Document number").fill("P-9988776");
  await page.getByRole("button", {name: "Save changes"}).click();
  // A generous timeout, not the default 5s: this is a plain Mongo PATCH with no real-network
  // dependency, but the snackbar is transient (auto-dismisses after 4s per Snackbar.tsx) - under
  // incidental system load the save can occasionally take long enough that the default budget
  // catches it mid-flight. The reload-based check below is the real persistence proof either way.
  await expect(page.getByText("Client updated")).toBeVisible({timeout: 10_000});

  await page.reload();
  await expect(page.getByLabel("Document type")).toHaveValue("passport");
  await expect(page.getByLabel("Document number")).toHaveValue("P-9988776");
});

test("walk-in fallback: no client record, free-text names, and the list shows plain text (no link)", async ({page}) => {
  const date = futureDate(32);
  await openCreateDialogOnEmptySlot(page, date);

  await page.getByRole("checkbox", {name: "Walk-in (no client record)"}).check();
  await expect(page.getByRole("combobox", {name: "Search clients"})).not.toBeVisible();
  await page.getByPlaceholder("Client name").fill("Walk-in Guest E2E");
  await page.getByPlaceholder("Pet name").fill("Walk-in Pet E2E");
  await page.getByRole("button", {name: "Create"}).click();
  await expect(page.getByText("Appointment created")).toBeVisible();

  await page.goto("/appointments");
  await page.getByPlaceholder("Search by client or pet name").fill("Walk-in Guest E2E");
  await expect(page.getByText("Walk-in Guest E2E")).toBeVisible();
  await expect(page.getByRole("link", {name: "Walk-in Guest E2E"})).not.toBeVisible();
});

test("public booking still creates a confirmed appointment (unchanged flow, regression)", async ({request}) => {
  const services = await request.get("/v1/booking/services");
  expect(services.ok()).toBe(true);
  const serviceList = await services.json();
  const service = serviceList.find((s: {name: string}) => s.name === "General checkup");
  expect(service).toBeTruthy();

  const from = new Date();
  const to = new Date(from.getTime() + 14 * 24 * 60 * 60 * 1000);
  const availability = await request.get(
    `/v1/booking/availability?serviceId=${service.id}&from=${from.toISOString()}&to=${to.toISOString()}`,
  );
  expect(availability.ok()).toBe(true);
  const availabilityBody = await availability.json();
  expect(availabilityBody.slots.length).toBeGreaterThan(0);

  const res = await request.post("/v1/booking/book", {
    data: {
      serviceId: service.id,
      startAt: availabilityBody.slots[0].startAt,
      client: {name: "Public Booking Regression", email: "public-regression@example.com"},
      petName: "Regression Pet",
    },
  });
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.status).toBe("confirmed");
  expect(body.appointmentId).toBeTruthy();
});

test("screenshots (both themes): calendar dialog with pickers, appointment detail, client form with ID fields", async ({page}) => {
  const client = await createClient(page, {name: "Shot Client", email: "shot-client@example.com", phone: "555-0501"});
  const petId = await createPet(page, "Shot Pet", [client.clientId]);
  const appointmentId = await createAppointmentApi(page, {
    clientId: client.clientId,
    petIds: [petId],
    startAt: Math.floor(Date.now() / 1000) + 50 * 86_400,
  });

  // 1. Calendar dialog with pickers filled in, both themes.
  const date = futureDate(51);
  for (const theme of ["Light", "Dark"] as const) {
    await page.goto(`/calendar?date=${date}&view=day`);
    await setTheme(page, theme);
    await page.getByRole("button", {name: new RegExp(`^New appointment ${date}`)}).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("combobox", {name: "Search clients"}).fill("Shot Client");
    await page.getByRole("option", {name: /Shot Client/}).click();
    await page.getByRole("combobox", {name: "Search pets"}).click();
    await page.getByRole("option", {name: /^Shot Pet/}).click();
    await page.screenshot({path: `${SHOTS_DIR}/dialog-with-pickers-${theme.toLowerCase()}.png`});
    await page.getByRole("button", {name: "Cancel"}).click();
  }

  // 2. Appointment detail page, both themes.
  for (const theme of ["Light", "Dark"] as const) {
    await page.goto(`/appointments/${appointmentId}`);
    await setTheme(page, theme);
    await page.screenshot({path: `${SHOTS_DIR}/appointment-detail-${theme.toLowerCase()}.png`, fullPage: true});
  }

  // 3. Client form with ID fields, both themes.
  for (const theme of ["Light", "Dark"] as const) {
    await page.goto(`/clients/${client.clientId}`);
    await setTheme(page, theme);
    await page.getByLabel("Document type").selectOption("national_id");
    await page.getByLabel("Document number").fill("N-12345");
    await page.screenshot({path: `${SHOTS_DIR}/client-id-fields-${theme.toLowerCase()}.png`, fullPage: true});
  }
});
