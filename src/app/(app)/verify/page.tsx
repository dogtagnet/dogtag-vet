import {PageHeader} from "@/components/shell/PageHeader";
import {connectToDatabase} from "@/lib/db";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {VerifySessionPanel} from "@/app/(app)/verify/VerifySessionPanel";

export default async function Page() {
  await connectToDatabase();
  const settings = await getClinicSettings();

  return (
    <>
      <PageHeader title="Verify" description="Start a consent-verification session as the relayer." />
      <VerifySessionPanel
        cloneAddress={settings.cloneAddress}
        consentRelayerViaCloneEnabled={Boolean(settings.consentRelayerViaCloneEnabled)}
      />
    </>
  );
}
