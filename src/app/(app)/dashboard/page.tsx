import Link from "next/link";
import {PageHeader} from "@/components/shell/PageHeader";
import {Banner} from "@/components/ui/Banner";
import {connectToDatabase} from "@/lib/db";
import {getClinicSettings} from "@/lib/models/ClinicSettings";

export default async function DashboardPage() {
  let cloneConfigured = false;
  try {
    await connectToDatabase();
    const settings = await getClinicSettings();
    cloneConfigured = Boolean(settings.cloneAddress);
  } catch {
    // No MONGODB_URI configured yet (fresh checkout) - render the dashboard without clinic state
    // rather than crashing the page; the banner below still tells the operator what to do.
  }

  return (
    <>
      <PageHeader title="Dashboard" description="Your clinic's DogTag deployment at a glance." />
      {!cloneConfigured && (
        <Banner
          tone="warn"
          title="Setup is not complete"
          dismissKey="setup-incomplete"
          action={
            <Link
              href="/setup"
              className="inline-flex items-center justify-center rounded-control border border-border-strong bg-surface px-4 py-2 text-body font-medium text-ink hover:bg-surface-2"
            >
              Open setup wizard
            </Link>
          }
        >
          Connect a wallet and discover this clinic&apos;s VetIssuer clone to start issuing tags.
        </Banner>
      )}
    </>
  );
}
