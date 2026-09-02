import {MongoClient} from "mongodb";
import {expect, test, type Page} from "@playwright/test";
import {E2E_MONGO_URI} from "./mongo-fixture";
import {getLastSentTxHash, setRpcReceipt, setRpcScenario} from "./rpcStub";

/**
 * WP4.7C item 4 - the end-to-end proof of items 2+3's whole point (K2, Kenneth's verbatim ask): a
 * vet registers THEIR OWN wallet (never an owner acting on their behalf - unlike
 * practitioner-mode.spec.ts's own flow 1+2, which predates this WP's self-service route and is
 * still the owner-assigns-it path, unchanged), sees an honest "not whitelisted" status and banner,
 * an owner grants the on-chain operator, and the vet's OWN status flips to whitelisted with no
 * further action from them beyond a normal page load.
 *
 * A dedicated vet email and clone address, distinct from practitioner-mode.spec.ts's own
 * (vet-wp47@example.com / clone 0x...ab / wallet 0x...cd) - this suite runs every spec file
 * sequentially against ONE shared Mongo database (playwright.config.ts: workers 1, fullyParallel
 * false), and this repo has a documented history of cross-spec state leakage when two files reuse
 * the same identifiers. "vet-wp47c@example.com" is NOT a substring match risk against
 * "vet-wp47@example.com" either direction (the extra "c" breaks contiguous substring matching both
 * ways), which matters because OperatorsSection's panel legitimately shows BOTH vets' rows by the
 * time this file runs (practitioner-mode.spec.ts ran first, alphabetically, and never removes its
 * own vet's recorded wallet) - every locator below that touches that panel is scoped to THIS file's
 * own vet's row by that email string, never to the panel as a whole.
 */

const VET_EMAIL = "vet-wp47c@example.com";
const CLONE_ADDRESS = "0x00000000000000000000000000000000000000ce";

const SHOTS_DIR =
  "/private/tmp/claude-501/-Users-zhenhaowu-code-dogtag/85e989bd-eec1-4250-ab09-83fb3244d856/scratchpad/wp47c-shots";

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

/** Scoped to MY card only - `page.locator("section", {hasText: "My issuance wallet"})` - never
 * `getByLabel("Wallet address")` at the page level, which is genuinely ambiguous here:
 * StaffSection's "Practitioner profiles" ALSO renders a `label="Wallet address"` field for every
 * vet/owner row, including the signed-in vet's own (read-only for them, but still present in the
 * DOM), and this card adds a second one with the identical label text. */
function myWalletCard(page: Page) {
  return page.locator("section", {hasText: "My issuance wallet"});
}

/** Scoped to /tags's own banner, disambiguated from /tags/issue's separate, pre-existing
 * "Issuer domain not configured" banner (also `role="status"`) by its own title text - the two
 * are unrelated conditions that can legitimately both be visible on /tags/issue at once. */
function walletStatusBanner(page: Page) {
  return page.getByRole("status").filter({hasText: "Check your issuance access"});
}

test.describe.serial("WP4.7C - vet self-service wallet + whitelist status", () => {
  test("vet registers their own wallet via 'Use connected wallet' and sees an honest NOT-whitelisted status + banner", async ({page}) => {
    // Bootstrap: owner@example.com is the first-ever staff row this deployment sees (same rule
    // practitioner-mode.spec.ts's own comment documents) - idempotent if some other spec already
    // ran first in this invocation.
    await devLogin(page, "owner@example.com");

    const client = await mongo();
    await client
      .db()
      .collection<{_id: string; cloneAddress?: string}>("clinicsettings")
      .updateOne({_id: "singleton"}, {$set: {cloneAddress: CLONE_ADDRESS}}, {upsert: true});
    await client.close();

    // Inviting is still owner-only (D4, unchanged by this WP) - everything from here on is the
    // VET acting on their OWN session, which is this WP's whole point.
    await page.goto("/settings");
    await page.getByLabel("Invite by email").fill(VET_EMAIL);
    await page.getByLabel("Role to invite as").selectOption("vet");
    await page.getByRole("button", {name: "Invite"}).click();
    await expect(page.getByText(`Invited ${VET_EMAIL}`)).toBeVisible({timeout: 15_000});

    await page.context().clearCookies();
    await devLogin(page, VET_EMAIL);
    await page.goto("/settings");

    const card = myWalletCard(page);
    await expect(card.getByText("No address on file", {exact: true})).toBeVisible({timeout: 10_000});
    await expect(card.getByText(/No wallet address is on file for you yet/)).toBeVisible();

    // The e2e mock connector auto-connects on this wallet-gated page (Providers.tsx) - the vet
    // fills their OWN connected address, never types one by hand and never asks an owner.
    await card.getByRole("button", {name: "Use connected wallet"}).click();
    const addressInput = card.locator("#my-wallet-address");
    const filledValue = await addressInput.inputValue();
    expect(filledValue).toMatch(/^0x[0-9a-fA-F]{40}$/);

    await Promise.all([
      page.waitForResponse((res) => res.url().includes("/api/settings/staff/me/wallet") && res.request().method() === "PATCH"),
      card.getByRole("button", {name: "Save"}).click(),
    ]);
    await expect(card.getByText("NOT whitelisted", {exact: true})).toBeVisible({timeout: 15_000});
    await expect(card.getByText(/you cannot issue DogTags until an owner adds it/)).toBeVisible();

    // /tags: the same honest status, from the SAME shared helper (item 3) - the exact reason
    // Kenneth's own ask (K2) asks for, never a false "whitelisted".
    await page.goto("/tags");
    const tagsBanner = walletStatusBanner(page);
    await expect(tagsBanner).toBeVisible();
    await expect(tagsBanner).toContainText("not whitelisted on the clinic clone");

    // /tags/issue: same banner component, same status - proven present here too (item 3's own
    // text names both pages), disambiguated from the pre-existing, UNRELATED "Issuer domain not
    // configured" banner also visible on this page (no business profile domain is configured in
    // this test). The full grant-then-flip transition is proven once, on /tags, in the next test -
    // re-proving it a second time on /tags/issue would exercise no new wiring.
    await page.goto("/tags/issue");
    await expect(walletStatusBanner(page)).toContainText("not whitelisted on the clinic clone");
    await expect(page.getByText("Issuer domain not configured")).toBeVisible();

    // Both-theme screenshots of the card (settings) and the banner (/tags) - a one-time visual
    // check, same precedent as WP4.7A's own item 5/7/9 (not committed to the repo - see the
    // builder's final report for these paths).
    await page.goto("/settings");
    await expect(card.getByText("NOT whitelisted", {exact: true})).toBeVisible();
    await card.screenshot({path: `${SHOTS_DIR}/wallet-card-not-whitelisted-light.png`});
    await page.getByRole("radio", {name: "Dark"}).click();
    await card.screenshot({path: `${SHOTS_DIR}/wallet-card-not-whitelisted-dark.png`});
    await page.getByRole("radio", {name: "Light"}).click();

    await page.goto("/tags");
    const banner = walletStatusBanner(page);
    await expect(banner).toBeVisible();
    await banner.screenshot({path: `${SHOTS_DIR}/tags-banner-light.png`});
    await page.getByRole("radio", {name: "Dark"}).click();
    await banner.screenshot({path: `${SHOTS_DIR}/tags-banner-dark.png`});
    await page.getByRole("radio", {name: "Light"}).click();
  });

  test("owner grants the on-chain operator; the vet's own status flips to Whitelisted and the banner disappears, with no vet action beyond a reload", async ({page}) => {
    await devLogin(page, "owner@example.com");
    await page.goto("/settings");

    // Read the vet's recorded address back from Mongo (never re-typed) so a transcription slip in
    // this test can't silently pass - this is exactly the address the previous test saved via
    // "Use connected wallet".
    const client = await mongo();
    const vetStaff = await client.db().collection<{email: string; walletAddress?: string}>("staffs").findOne({email: VET_EMAIL});
    await client.close();
    expect(vetStaff?.walletAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const vetWallet = vetStaff!.walletAddress!;

    // OperatorsSection's panel legitimately has more than one row by now (see this file's own
    // header comment) - scoped to the row for THIS file's vet specifically, never the panel as a
    // whole, and never asserting how many rows exist. OperatorRow renders `practitionerDisplayName`
    // (the email's LOCAL PART, since this vet never set a display name - StaffSection's OWN rows
    // show the full email, but OperatorRow does not), confirmed empirically against a real page
    // snapshot after this exact locator (originally `hasText: VET_EMAIL`) matched nothing here -
    // the full email string is genuinely absent from this section's DOM.
    const vetLocalPart = VET_EMAIL.split("@")[0]; // "vet-wp47c" - not a substring superset risk
    // against practitioner-mode.spec.ts's "vet-wp47"/"vetb-wp47" (neither contains the trailing
    // "c"), and its own local part is never a substring of THIS one either.
    const operatorsPanel = page.locator("section", {hasText: "Issuance operators"});
    const vetRow = operatorsPanel.locator("div.rounded-control", {hasText: vetLocalPart});
    await expect(vetRow.getByText("Inactive", {exact: true})).toBeVisible({timeout: 10_000});

    await vetRow.getByRole("button", {name: "Add operator"}).click();
    await expect.poll(async () => getLastSentTxHash(), {timeout: 15_000}).not.toBeNull();
    const addHash = await getLastSentTxHash();
    await setRpcReceipt(addHash!, "success");
    // rpcStub is a stateless-per-call mock, not a real EVM - the read half is scripted separately,
    // same convention practitioner-mode.spec.ts's own flow 1+2 already established.
    await setRpcScenario("operators", CLONE_ADDRESS, [vetWallet], true);
    await expect(vetRow.getByText("Active", {exact: true})).toBeVisible({timeout: 15_000});

    // Back to the vet's OWN session - no action from them at all beyond a normal page load. The
    // item-3 status cache is short (5s) specifically so this works within a reasonable timeout,
    // but the owner's steps above (a real tx-hash poll + a receipt + a scenario write) already
    // took several real seconds by themselves - wrapped in expect.poll with its own reload rather
    // than trusting a single navigation, so a cache entry that happens to still be live when this
    // runs doesn't turn into a flaky failure instead of a clean wait.
    await page.context().clearCookies();
    await devLogin(page, VET_EMAIL);
    await page.goto("/settings");
    const card = myWalletCard(page);
    await expect
      .poll(
        async () => {
          const text = await card.textContent();
          if (text?.includes("Whitelisted") && !text.includes("NOT whitelisted")) return "whitelisted";
          await page.reload();
          return "not-yet";
        },
        {timeout: 20_000, intervals: [1_000, 2_000, 3_000]},
      )
      .toBe("whitelisted");
    await expect(card.getByText("Whitelisted", {exact: true})).toBeVisible();
    await expect(card.getByText("NOT whitelisted", {exact: true})).toHaveCount(0);

    await page.goto("/tags");
    await expect(walletStatusBanner(page)).toHaveCount(0);
  });
});
