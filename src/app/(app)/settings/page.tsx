import {PageHeader} from "@/components/shell/PageHeader";
import {Banner} from "@/components/ui/Banner";
import {KeyValuePanel} from "@/components/ui/KeyValuePanel";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {AddressChip} from "@/components/ui/AddressChip";
import {connectToDatabase} from "@/lib/db";
import {AvailabilityException, AvailabilityRule, getBookingSettings} from "@/lib/models/Availability";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {getServerEnv} from "@/lib/env";
import {listRecentAbuse} from "@/lib/abuseLog";
import {AbuseLogSection} from "@/app/(app)/settings/AbuseLogSection";
import {BookingConfigSection} from "@/app/(app)/settings/BookingConfigSection";
import {IcsFeedSection} from "@/app/(app)/settings/IcsFeedSection";
import {SettingsForm} from "@/app/(app)/settings/SettingsForm";

export default async function SettingsPage() {
  await connectToDatabase();
  const [settings, bookingSettings, rules, exceptions, abuseEntries] = await Promise.all([
    getClinicSettings(),
    getBookingSettings(),
    AvailabilityRule.find({}).lean(),
    AvailabilityException.find({}).sort({date: 1}).lean(),
    listRecentAbuse(),
  ]);
  const env = getServerEnv();
  const smtpConfigured = Boolean(env.EMAIL_SERVER && env.EMAIL_FROM);

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
        <BookingConfigSection settings={bookingSettings} rules={rules} exceptions={exceptions} />
        <IcsFeedSection initialToken={settings.icsFeedToken} publicBaseUrl={env.PUBLIC_BASE_URL} />
        <AbuseLogSection entries={abuseEntries} />
      </div>
    </>
  );
}
