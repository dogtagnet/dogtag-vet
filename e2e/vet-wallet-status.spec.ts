import {MongoClient} from "mongodb";
import {expect, test, type Page} from "@playwright/test";
import {E2E_MONGO_URI} from "./mongo-fixture";
import {getLastSentTxHash, setRpcReceipt, setRpcScenario} from "./rpcStub";
// Relative, not the "@/..." alias - the established pattern for an e2e file reaching into src/
// (`practitioner-mode.spec.ts` imports `../src/lib/booking/dst`; `runBootRecovery.ts` imports
// `../src/lib/db`), so this needs no new loader behavior. Importing the real `truncateMiddle`
// rather than re-deriving it keeps these assertions from drifting if the component's truncation
// ever changes.
import {truncateMiddle} from "../src/lib/format";

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
// WP4.7C GRADE ROUND 1 D1 - a second address, distinct from both this file's vetWallet and
// practitioner-mode.spec.ts's own identifiers, used below to prove the mismatch half of the
// banner renders independently of the status-issue half.
const OTHER_WALLET = "0x00000000000000000000000000000000000000aa";

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

/** WP4.7C GRADE ROUND 1 D1 - escapes regex metacharacters so a literal string (specifically
 * `truncateMiddle`'s own "..." middle separator) can be embedded in a `RegExp` without being
 * interpreted as a wildcard. Needed because wagmi's mock connector returns a CHECKSUMMED address
 * (`useAccount().address`) while the recorded one round-trips through Mongo lowercased
 * (`lowercaseHexAddress`, selfWalletRoute) - `toContainText`'s plain-string form is case-sensitive
 * and would fail against the render even though the render is correct, so every address assertion
 * below builds a case-insensitive `RegExp` from this instead. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test.describe.serial("WP4.7C - vet self-service wallet + whitelist status", () => {
  test("vet registers their own wallet via 'Use connected wallet' and sees an honest NOT-whitelisted status + banner", async ({page}) => {
    // Generous, not the 30s default - see calendar-services.spec.ts's/booking-config-timezone.spec.ts's/
    // tag-custody.spec.ts's own identical note (WP4.13 fix round 2, grader R2). This test does FOUR
    // full navigations (/settings, /tags, /tags/issue, /settings again for screenshots), each a
    // first-hit cold client compile the first time this suite touches that route, plus its own
    // explicit 10s and 15s internal waits - between the compiles and those two waits alone, little
    // of the 30s default is left for the rest of the test. Reproduced failing 2/2 in full-suite runs
    // under NORMAL load (not just heavy load) while passing 3/3 in isolation - the identical
    // class of defect as tag-custody.spec.ts:151, fixed the same way.
    test.setTimeout(60_000);
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

  /**
   * WP4.7C GRADE ROUND 1 D1 (fix) - `VetWalletStatusBanner` has two independent halves
   * (`decideVetWalletBanner`, staffRoleTone.ts): `showStatusIssue` (a missing/not-whitelisted/
   * unreadable recorded address) and `showMismatch` (the CONNECTED wallet differs from the
   * RECORDED one - true even when the recorded one is whitelisted). Tests 1+2 above only ever
   * exercise `showStatusIssue`; the grader proved the entire `showMismatch` JSX block could be
   * deleted from `VetWalletStatusBanner.tsx` and both tests would still pass. This test renders
   * the two things tests 1+2 never do: the mismatch paragraph (isolated from `showStatusIssue` by
   * whitelisting the NEW recorded address too, so only the mismatch fact has anything to render),
   * and the /tags no-address banner (test 1 only ever checks that copy on the settings CARD,
   * before ever navigating to /tags with no address saved).
   *
   * Depends on test 2 having left the vet whitelisted with recorded == connected (the clean
   * baseline asserted first, below) - same `describe.serial` dependency test 2 itself has on
   * test 1.
   *
   * GOTCHA: wagmi's mock connector (`NEXT_PUBLIC_E2E_MOCK_WALLET_ADDRESS`, playwright.config.ts)
   * returns a CHECKSUMMED address; the recorded one round-trips through Mongo lowercased. Every
   * address assertion below is a case-insensitive `RegExp` (via `escapeRegExp`), never a plain
   * string.
   */
  test("connected wallet different from a whitelisted recorded address renders the mismatch half; clearing the recorded address renders the /tags no-address half", async ({page}) => {
    await devLogin(page, VET_EMAIL);

    // Clean baseline left by test 2: recorded == connected (case-insensitively) and whitelisted,
    // so neither half has anything to show.
    await page.goto("/tags");
    await expect(walletStatusBanner(page)).toHaveCount(0);

    // Whitelist a SECOND address before it is ever recorded, so once it IS recorded,
    // `showStatusIssue` stays false and only the independent `showMismatch` fact has anything to
    // say - isolating the mismatch branch from the status-issue branch.
    await setRpcScenario("operators", CLONE_ADDRESS, [OTHER_WALLET], true);

    await page.goto("/settings");
    const card = myWalletCard(page);
    const addressInput = card.locator("#my-wallet-address");
    // The input's current value is the server's recorded address, which by now equals the
    // connected mock wallet case-insensitively (test 2's own close) - captured here rather than
    // re-derived from Mongo, since it is exactly the string the mismatch paragraph renders as
    // "your connected wallet".
    const connectedWallet = await addressInput.inputValue();
    expect(connectedWallet).toMatch(/^0x[0-9a-fA-F]{40}$/);

    await addressInput.fill(OTHER_WALLET);
    await Promise.all([
      page.waitForResponse((res) => res.url().includes("/api/settings/staff/me/wallet") && res.request().method() === "PATCH"),
      card.getByRole("button", {name: "Save"}).click(),
    ]);
    // The now-recorded address is whitelisted too (see setRpcScenario above) - proves the
    // isolation BEFORE checking the banner: showStatusIssue is false here, so anything the banner
    // shows next can only be the independent mismatch fact.
    await expect(card.getByText("Whitelisted", {exact: true})).toBeVisible({timeout: 15_000});

    await page.goto("/tags");
    const mismatchBanner = walletStatusBanner(page);
    await expect(mismatchBanner).toBeVisible();
    await expect(mismatchBanner).toContainText(/issuing uses whichever wallet is actually connected, not the recorded one/i);
    await expect(mismatchBanner).toContainText(new RegExp(escapeRegExp(truncateMiddle(connectedWallet)), "i"));
    await expect(mismatchBanner).toContainText(new RegExp(escapeRegExp(truncateMiddle(OTHER_WALLET)), "i"));
    await expect(mismatchBanner).not.toContainText(/not whitelisted on the clinic clone/i);

    // The /tags no-address half - test 1 only ever checks this copy on the settings CARD, before
    // ever navigating to /tags with no address saved.
    await page.goto("/settings");
    await Promise.all([
      page.waitForResponse((res) => res.url().includes("/api/settings/staff/me/wallet") && res.request().method() === "PATCH"),
      card.getByRole("button", {name: "Clear"}).click(),
    ]);
    await expect(card.getByText("No address on file", {exact: true})).toBeVisible({timeout: 15_000});

    await page.goto("/tags");
    await expect(walletStatusBanner(page)).toContainText(/No wallet address is on file for you yet/i);
  });
});
