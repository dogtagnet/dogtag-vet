import {PageHeader} from "@/components/shell/PageHeader";
import {VerifyModeNav} from "@/components/verify/VerifyModeNav";
import {VerifyRecordsPanel} from "@/app/(app)/verify/records/VerifyRecordsPanel";

export default function Page() {
  return (
    <>
      <PageHeader title="Verify" description="Present a vaccination record for independent verification." />
      <VerifyModeNav active="/verify/records" />
      <VerifyRecordsPanel />
    </>
  );
}
