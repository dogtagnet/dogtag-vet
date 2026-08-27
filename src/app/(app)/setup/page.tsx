import {PageHeader} from "@/components/shell/PageHeader";
import {SetupWizard} from "@/app/(app)/setup/SetupWizard";

export default function SetupPage() {
  return (
    <>
      <PageHeader
        title="Setup wizard"
        description="Connect a wallet and discover this clinic's VetIssuer clone on ROAX."
      />
      <SetupWizard />
    </>
  );
}
