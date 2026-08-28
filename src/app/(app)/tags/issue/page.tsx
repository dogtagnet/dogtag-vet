import Link from "next/link";
import {PageHeader} from "@/components/shell/PageHeader";
import {Banner} from "@/components/ui/Banner";
import {connectToDatabase} from "@/lib/db";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {TagIssueWizard} from "@/app/(app)/tags/issue/TagIssueWizard";

export default async function Page() {
  await connectToDatabase();
  const settings = await getClinicSettings();

  return (
    <>
      <PageHeader title="Issue tag" description="Mint a new DogTag for a client's pet." />
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
