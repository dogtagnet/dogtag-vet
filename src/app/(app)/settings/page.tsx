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
import {listBookablePractitioners} from "@/lib/booking/queries";
import {getServerEnv} from "@/lib/env";
import {listRecentAbuse} from "@/lib/abuseLog";
import {AbuseLogSection} from "@/app/(app)/settings/AbuseLogSection";
import {BookingConfigSection} from "@/app/(app)/settings/BookingConfigSection";
import {IcsFeedSection} from "@/app/(app)/settings/IcsFeedSection";
import {MyWalletSection} from "@/app/(app)/settings/MyWalletSection";
import {OperatorsSection} from "@/app/(app)/settings/OperatorsSection";
import {SettingsForm} from "@/app/(app)/settings/SettingsForm";
import {StaffSection} from "@/app/(app)/settings/StaffSection";
import {isVetOrOwner} from "@/lib/staffRoleTone";
import {toPlain} from "@/lib/toPlain";

export default async function SettingsPage() {
  await connectToDatabase();
  const [settings, bookingSettings, rules, exceptions, abuseEntries, staff, practitioners, session] = await Promise.all([
    getClinicSettings(),
    getBookingSettings(),
    AvailabilityRule.find({}).lean().then(toPlain),
    AvailabilityException.find({}).sort({date: 1}).lean().then(toPlain),
    listRecentAbuse(),
    listStaff(),
    listBookablePractitioners(),
    auth(),
  ]);
  const env = getServerEnv();
  const smtpConfigured = Boolean(env.EMAIL_SERVER && env.EMAIL_FROM);
  const isOwner = session?.user?.role === "owner";
  // WP4.7C item 2 - "My issuance wallet" is a vet/owner SELF-service card, scoped to the signed-in
  // staff member's own row (`staff` here already came from `listStaff()` above, so no extra query
  // is needed to find it). `myStaff` can only be missing for a session whose Staff row was deleted
  // out from under it mid-session (this app only ever disables, never deletes - Staff.ts's own doc
  // comment - so this is a defensive absence check, not an expected path).
  const myStaff = staff.find((s) => s.staffId === session?.user?.staffId);

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
        {isVetOrOwner(session?.user?.role) && myStaff && <MyWalletSection initial={myStaff} />}
        <OperatorsSection staff={staff} cloneAddress={settings.cloneAddress} isOwner={isOwner} />
        <BookingConfigSection settings={bookingSettings} rules={rules} exceptions={exceptions} practitioners={practitioners} isOwner={isOwner} />
        <IcsFeedSection initialToken={settings.icsFeedToken} publicBaseUrl={env.PUBLIC_BASE_URL} />
        <AbuseLogSection entries={abuseEntries} timeZone={bookingSettings.timezone} />
      </div>
    </>
  );
}
