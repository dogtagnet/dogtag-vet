/**
 * WP4.19 fix round 1 D1 - the exact admin-portal deep link `RequestTopUpButton.tsx` opens, pinned
 * here as a small, pure, unit-testable function rather than inline in that "use client" component.
 * Matches the grade's own recipe verbatim (`plans/orchestration/wp4.19-grade.md` D1): "the deep
 * link becomes `${ADMIN_PORTAL_URL}/status?kind=topup&wallet=${walletAddress}`".
 *
 * The admin's own status-form fix round (dogtag-admin, parallel wave) reads exactly these two
 * query params (`kind`, `wallet`) to preselect the "Fund operator wallet" request kind and prefill
 * the wallet address field - this repo's own half of that contract is pinned here, verbatim, so a
 * future change on either side breaks a test by name instead of silently drifting apart (grade
 * round 1 D1: before this fix, the button opened the bare `/status` page with neither parameter,
 * so no UI on the admin side could ever file a `topup` request from this link).
 *
 * `adminPortalUrl`'s own trailing slash (if any) is stripped first -
 * `RequestTopUpButton.tsx`'s pre-existing behavior, kept unchanged by this fix.
 */
export function buildTopUpRequestUrl(adminPortalUrl: string, walletAddress: string): string {
  return `${adminPortalUrl.replace(/\/+$/, "")}/status?kind=topup&wallet=${walletAddress}`;
}
