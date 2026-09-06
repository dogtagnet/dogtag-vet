import {PageHeader} from "@/components/shell/PageHeader";
import {VerifyModeNav} from "@/components/verify/VerifyModeNav";
import {VerifySessionPanel} from "@/app/(app)/verify/VerifySessionPanel";

export default function Page() {
  return (
    <>
      <PageHeader title="Verify" description="Start a consent-verification session as the relayer." />
      <VerifyModeNav active="/verify" />
      <VerifySessionPanel />
    </>
  );
}
