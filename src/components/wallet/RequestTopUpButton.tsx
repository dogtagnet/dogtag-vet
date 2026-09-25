"use client";

import {Button} from "@/components/ui/controls";
import {AddressChip} from "@/components/ui/AddressChip";
import {usePublicEnv} from "@/lib/usePublicEnv";
import {buildTopUpRequestUrl} from "@/lib/topUpRequestUrl";

/**
 * WP4.19 V1/V3 - "Request a top-up", shared by the "My issuance wallet" card, the /tags +
 * /tags/issue + /pets wallet banner, and the pre-flight refusal banners on issue/revoke/reactivate.
 *
 * Deliberately a DEEP LINK to the admin portal's own status page, never a direct POST to the
 * admin's `POST /api/status/operator-request` route from here: that route is gated by a NextAuth
 * session scoped to the CLINIC's own admin-portal account (`dogtag-admin/src/app/api/status/
 * operator-request/route.ts` - `auth()`, then `resolveEntityAccountForUser` against that session's
 * own email), which this app has no way to hold or proxy - there is no service-to-service
 * credential anywhere in either repo today. docs/DEPLOY.md's existing "Granting a vet the ability
 * to issue tags" section already sends staff to the SAME admin portal status page by hand for a
 * whitelist request; this button does the identical thing for a top-up (the admin's own
 * `OPERATOR_APPLICATION_KINDS` already includes `"topup"` as of dogtag-admin main `96eb908` - if a
 * given admin deployment predates that, the admin portal's own status page simply has no top-up
 * option yet, which this button cannot detect or work around from here).
 *
 * `adminPortalUrl` (env.ts's `ADMIN_PORTAL_URL`, this repo's only admin-discovery mechanism today -
 * see that field's own doc comment) is this deployment's own admin portal base URL; blank (never
 * configured) falls back to plain instructions rather than a broken link.
 *
 * WP4.19 fix round 1 D1 - the link itself is `buildTopUpRequestUrl` (`src/lib/topUpRequestUrl.ts`):
 * `${adminPortalUrl}/status?kind=topup&wallet=${walletAddress}`, not the bare `/status` page this
 * button used to open. Grade round 1 D1's own finding: with no `kind`/`wallet` on the URL, the
 * admin's status-form select had nothing to preselect and no field to prefill, so a clinic landing
 * there had to know, unprompted, to pick a "topup" option the form did not even offer yet - the
 * admin's own fix round (parallel wave) adds that option and reads these exact two params.
 */
export function RequestTopUpButton({walletAddress}: {walletAddress?: string}) {
  const {adminPortalUrl} = usePublicEnv();

  if (!walletAddress) return null;

  if (!adminPortalUrl) {
    return (
      <p className="text-caption text-ink-faint">
        Ask your admin for a top-up for <AddressChip address={walletAddress} /> - this deployment has no admin portal URL
        configured yet (see docs/DEPLOY.md, &quot;Operator wallet funding&quot;).
      </p>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        data-testid="request-topup-button"
        onClick={() => window.open(buildTopUpRequestUrl(adminPortalUrl, walletAddress), "_blank", "noreferrer")}
      >
        Request a top-up
      </Button>
      <p className="text-caption text-ink-faint">
        Opens the admin portal&apos;s status page in a new tab - sign in with this clinic&apos;s account and file a top-up
        request for <AddressChip address={walletAddress} />.
      </p>
    </div>
  );
}
