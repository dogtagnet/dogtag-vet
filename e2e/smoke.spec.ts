import {expect, test} from "@playwright/test";

/**
 * Definition-of-done smoke suite (wp4-vet.md): sign-in renders, the public booking API answers
 * availability for the seeded rules, a bad mint token 404s cleanly, and the theme toggle works.
 * Runs against a disposable docker-mongo instance seeded by `e2e/global-setup.ts` with the same
 * `pnpm seed` data a developer runs by hand.
 */

test("sign-in renders", async ({page}) => {
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", {name: "Staff sign in"})).toBeVisible();
  // DEV_LOGIN=1 is set for this whole suite (playwright.config.ts) - the dev-only credentials
  // form should be the one sign-in method actually offered in this environment.
  await expect(page.getByRole("button", {name: "Dev sign in (test only)"})).toBeVisible();
});

test("dev sign-in reaches the staff dashboard", async ({page}) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByRole("button", {name: "Dev sign in (test only)"}).click();
  // 15s, not the 5s default: on a cold `next dev` the post-sign-in navigation blocks on
  // /dashboard's first compile, which can outrun 5s - seen flaking live when a spec file runs
  // first/alone; the assertion itself (we DO land on the dashboard) is unchanged.
  await expect(page).toHaveURL(/\/dashboard$/, {timeout: 15_000});
});

test("booking API answers availability for the seeded rules", async ({request}) => {
  const services = await request.get("/v1/booking/services");
  expect(services.ok()).toBe(true);
  const serviceList = await services.json();
  expect(Array.isArray(serviceList)).toBe(true);
  expect(serviceList.length).toBeGreaterThan(0);
  const service = serviceList.find((s: {name: string}) => s.name === "General checkup");
  expect(service).toBeTruthy();

  // A 14-day window from now always spans at least one seeded Mon-Fri weekday, regardless of
  // which day the suite happens to run on.
  const from = new Date();
  const to = new Date(from.getTime() + 14 * 24 * 60 * 60 * 1000);
  const availability = await request.get(
    `/v1/booking/availability?serviceId=${service.id}&from=${from.toISOString()}&to=${to.toISOString()}`,
  );
  expect(availability.ok()).toBe(true);
  const body = await availability.json();
  expect(Array.isArray(body.slots)).toBe(true);
  expect(body.slots.length).toBeGreaterThan(0);
  expect(body.slots[0]).toHaveProperty("startAt");
  expect(body.slots[0]).toHaveProperty("endAt");
});

test("a bad mint token 404s cleanly", async ({request}) => {
  const response = await request.get("/p/deadbeefdeadbeefdeadbeefdeadbeef", {
    headers: {accept: "application/json"},
  });
  expect(response.status()).toBe(404);
  const body = await response.json();
  expect(body).toHaveProperty("error");
});

test("theme toggle works", async ({page}) => {
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).not.toHaveClass(/dark/);

  await page.getByRole("radio", {name: "Dark"}).click();
  await expect(html).toHaveClass(/dark/);

  await page.getByRole("radio", {name: "Light"}).click();
  await expect(html).not.toHaveClass(/dark/);
});
