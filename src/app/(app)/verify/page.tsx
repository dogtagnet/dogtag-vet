import {PageHeader} from "@/components/shell/PageHeader";
import {connectToDatabase} from "@/lib/db";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {VerifyModeNav} from "@/components/verify/VerifyModeNav";
import {VerifySessionPanel} from "@/app/(app)/verify/VerifySessionPanel";

export default async function Page() {
  await connectToDatabase();
  const settings = await getClinicSettings();

  return (
    <>
      <PageHeader title="Verify" description="Start a consent-verification session as the relayer." />
      <VerifyModeNav active="/verify" />
      <VerifySessionPanel
        cloneAddress={settings.cloneAddress}
        consentRelayerViaCloneEnabled={Boolean(settings.consentRelayerViaCloneEnabled)}
      />
    </>
  );
}
