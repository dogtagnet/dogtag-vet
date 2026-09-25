import {describe, expect, it} from "vitest";
import {buildTopUpRequestUrl} from "@/lib/topUpRequestUrl";

/**
 * WP4.19 fix round 1 D1 - pins the exact deep link `RequestTopUpButton.tsx` opens, per the grade's
 * own recipe (`plans/orchestration/wp4.19-grade.md` D1): "the deep link becomes
 * `${ADMIN_PORTAL_URL}/status?kind=topup&wallet=${walletAddress}`". Bite: dropping either query
 * parameter (or the `kind=topup` value) from `buildTopUpRequestUrl`'s own template string turns
 * this test red by name.
 */
describe("buildTopUpRequestUrl - WP4.19 fix round 1 D1", () => {
  it("pins the exact admin-portal deep link the vet's Request a top-up button opens", () => {
    expect(buildTopUpRequestUrl("https://admin.example-clinic.test", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb9226")).toBe(
      "https://admin.example-clinic.test/status?kind=topup&wallet=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb9226",
    );
  });

  it("strips a trailing slash on adminPortalUrl before appending the path - pre-existing behavior, unchanged", () => {
    expect(buildTopUpRequestUrl("https://admin.example-clinic.test/", "0xWallet")).toBe(
      "https://admin.example-clinic.test/status?kind=topup&wallet=0xWallet",
    );
  });

  it("strips more than one trailing slash the same way the pre-existing regex did", () => {
    expect(buildTopUpRequestUrl("https://admin.example-clinic.test//", "0xWallet")).toBe(
      "https://admin.example-clinic.test/status?kind=topup&wallet=0xWallet",
    );
  });
});
