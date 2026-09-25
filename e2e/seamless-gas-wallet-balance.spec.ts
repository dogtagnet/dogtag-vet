import {expect, test, type Page} from "@playwright/test";
import {resetRpcStub, setRpcBalance} from "./rpcStub";

/**
 * End-to-end coverage for plans/wp4.19-seamless-gas.md's vet-side checklist item V1: the "My
 * issuance wallet" card and the /tags wallet banner show the connected wallet's live PLASMA
 * balance and a low-balance warning with a top-up request. Follows mint-issue-revert.spec.ts's own
 * established conventions (mock wallet connector via `NEXT_PUBLIC_E2E_MOCK_WALLET_ADDRESS`) rather
 * than re-deriving new ones.
 */

const CLONE_ADDRESS = "0x7b9bf16f0e39AdF8c38d8491F4C7E9C17E85D703"; // same literal every sibling suite in this repo already configures
const MOCK_WALLET_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // playwright.config.ts's own NEXT_PUBLIC_E2E_MOCK_WALLET_ADDRESS default

async function signInAsStaff(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("owner@example.com");
  await page.getByRole("button", {name: "Dev sign in (test only)"}).click();
  await expect(page).toHaveURL(/\/dashboard$/, {timeout: 15_000});
}

async function configureClinic(page: Page) {
  const res = await page.request.patch("/api/settings", {
    data: {cloneAddress: CLONE_ADDRESS, businessProfile: {name: "Example Vet Clinic"}},
  });
  expect(res.ok()).toBe(true);
}

test.beforeEach(async ({page}) => {
  await signInAsStaff(page);
  await configureClinic(page);
  await resetRpcStub();
  // rpcStub's own DEFAULT_BALANCE_WEI (10 PLASMA) comfortably clears OPERATOR_LOW_PLASMA's 0.1
  // PLASMA default - the tests that need a LOW balance script one explicitly, over that default.
});

test.describe("V1 - My issuance wallet card + /tags banner show live PLASMA balance", () => {
  test("a healthy balance shows the amount with no low-balance warning", async ({page}) => {
    await setRpcBalance(MOCK_WALLET_ADDRESS, 5_000_000_000_000_000_000n); // 5 PLASMA
    await page.goto("/settings");
    const card = page.locator("section", {hasText: "My issuance wallet"});
    await expect(card.getByTestId("issuance-wallet-balance")).toContainText("5 PLASMA", {timeout: 15_000});
    await expect(card.getByTestId("low-balance-warning")).toHaveCount(0);
  });

  test("a balance below OPERATOR_LOW_PLASMA shows the warning and a Request a top-up button", async ({page}) => {
    await setRpcBalance(MOCK_WALLET_ADDRESS, 50_000_000_000_000_000n); // 0.05 PLASMA, below the 0.1 default
    await page.goto("/settings");
    const card = page.locator("section", {hasText: "My issuance wallet"});
    await expect(card.getByTestId("issuance-wallet-balance")).toContainText("0.05 PLASMA", {timeout: 15_000});
    await expect(card.getByTestId("low-balance-warning")).toBeVisible();
    await expect(card.getByTestId("request-topup-button")).toBeVisible();
  });

  test("the /tags banner shows the same balance and warning (the status this banner already drives, extended)", async ({page}) => {
    await setRpcBalance(MOCK_WALLET_ADDRESS, 50_000_000_000_000_000n); // 0.05 PLASMA
    await page.goto("/tags");
    await expect(page.getByTestId("issuance-wallet-balance")).toContainText("0.05 PLASMA", {timeout: 15_000});
    await expect(page.getByTestId("low-balance-warning")).toBeVisible();
  });
});

/**
 * `RequestTopUpButton.tsx`'s OTHER branch - no `ADMIN_PORTAL_URL` configured at all - is
 * deliberately NOT covered by an e2e test in this suite: `playwright.config.ts`'s `webServer` is
 * one shared `next dev` process for the whole run (every spec file), so a per-test env override
 * would need a second server. The branch itself is a single ternary with no chain interaction, and
 * `src/components/wallet/RequestTopUpButton.tsx`'s own doc comment states the fallback explicitly -
 * an honest, disclosed scope boundary rather than a silent gap.
 */
