import {PageHeader} from "@/components/shell/PageHeader";
import {Banner} from "@/components/ui/Banner";
import {KeyValuePanel} from "@/components/ui/KeyValuePanel";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {AddressChip} from "@/components/ui/AddressChip";
import {auth} from "@/auth";
import {connectToDatabase} from "@/lib/db";
import {AvailabilityException, AvailabilityRule, getBookingSettings} from "@/lib/models/Availability";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {listStaff} from "@/lib/models/Staff";
import {getServerEnv} from "@/lib/env";
import {listRecentAbuse} from "@/lib/abuseLog";
import {AbuseLogSection} from "@/app/(app)/settings/AbuseLogSection";
import {BookingConfigSection} from "@/app/(app)/settings/BookingConfigSection";
import {IcsFeedSection} from "@/app/(app)/settings/IcsFeedSection";
import {SettingsForm} from "@/app/(app)/settings/SettingsForm";
import {StaffSection} from "@/app/(app)/settings/StaffSection";
import {toPlain} from "@/lib/toPlain";

export default async function SettingsPage() {
  await connectToDatabase();
  const [settings, bookingSettings, rules, exceptions, abuseEntries, staff, session] = await Promise.all([
    getClinicSettings(),
    getBookingSettings(),
    AvailabilityRule.find({}).lean().then(toPlain),
    AvailabilityException.find({}).sort({date: 1}).lean().then(toPlain),
    listRecentAbuse(),
    listStaff(),
    auth(),
  ]);
  const env = getServerEnv();
  const smtpConfigured = Boolean(env.EMAIL_SERVER && env.EMAIL_FROM);
  const isOwner = session?.user?.role === "owner";

  return (
    <>
      <PageHeader title="Settings" description="Deployment configuration for this clinic." />
      <div className="mb-6 max-w-2xl">
        <KeyValuePanel
          title="Chain identity"
          rows={[
            {
              key: "entity",
              label: "Entity account",
              value: settings.entityAccount ? (
                <AddressChip address={settings.entityAccount} chain="roax" />
              ) : (
                "Not set up yet"
              ),
            },
            {
              key: "clone",
              label: "Clone address",
              value: settings.cloneAddress ? (
                <AddressChip address={settings.cloneAddress} chain="roax" />
              ) : (
                "Not set up yet"
              ),
            },
            {
              key: "smtp",
              label: "SMTP",
              value: smtpConfigured ? (
                <StatusBadge tone="ok" label="Configured" />
              ) : (
                <StatusBadge tone="neutral" label="Not configured" />
              ),
            },
          ]}
        />
      </div>
      {!settings.cloneAddress && (
        <div className="mb-6 max-w-2xl">
          <Banner tone="info" title="Chain identity is not set up" dismissKey="settings-no-clone">
            Run the setup wizard to connect a wallet and discover this clinic&apos;s clone.
          </Banner>
        </div>
      )}
      <SettingsForm initial={settings} />
      <div className="mt-6 max-w-2xl space-y-6">
        <StaffSection initial={staff} isOwner={isOwner} currentStaffId={session?.user?.staffId} />
        <BookingConfigSection settings={bookingSettings} rules={rules} exceptions={exceptions} />
        <IcsFeedSection initialToken={settings.icsFeedToken} publicBaseUrl={env.PUBLIC_BASE_URL} />
        <AbuseLogSection entries={abuseEntries} timeZone={bookingSettings.timezone} />
      </div>
    </>
  );
}
