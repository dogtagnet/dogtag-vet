import Link from "next/link";
import {redirect} from "next/navigation";
import {PageHeader} from "@/components/shell/PageHeader";
import {Banner} from "@/components/ui/Banner";
import {auth} from "@/auth";
import {connectToDatabase} from "@/lib/db";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {Staff, type StaffDoc} from "@/lib/models/Staff";
import {resolveOperatorStatus} from "@/lib/issuanceOperatorStatus";
import {isVetOrOwner} from "@/lib/staffRoleTone";
import {TagIssueWizard} from "@/app/(app)/tags/issue/TagIssueWizard";
import {VetWalletStatusBanner} from "@/app/(app)/tags/VetWalletStatusBanner";

/** Same WP4.7 A2 gate as `/tags` - see that page's doc comment. */
export default async function Page() {
  const session = await auth();
  if (!isVetOrOwner(session?.user?.role)) {
    redirect("/dashboard?notice=vet-required");
  }

  await connectToDatabase();
  const [settings, staffRow] = await Promise.all([
    getClinicSettings(),
    Staff.findOne({staffId: session?.user?.staffId}).lean<StaffDoc>(),
  ]);
  // WP4.7C item 3(b) - same helper, same cache, as /tags and the /settings card (see that page's
  // own comment on why this can never disagree with those).
  const operatorStatus = await resolveOperatorStatus({
    walletAddress: staffRow?.walletAddress,
    cloneAddress: settings.cloneAddress,
  });

  return (
    <>
      <PageHeader title="Issue tag" description="Mint a new DogTag for a client's pet." />
      <VetWalletStatusBanner status={operatorStatus.status} recordedAddress={operatorStatus.recordedAddress} />
      {!settings.businessProfile.domain && (
        <Banner
          tone="warn"
          title="Issuer domain not configured"
          dismissKey="tags-issue-no-domain"
          action={
            <Link href="/settings" className="text-body font-medium text-link hover:underline">
              Open settings
            </Link>
          }
        >
          A tag can still be issued on chain, but signing its C3 issuer attestation will be refused
          until this clinic&apos;s issuer domain is set in Settings.
        </Banner>
      )}
      <TagIssueWizard />
    </>
  );
}
