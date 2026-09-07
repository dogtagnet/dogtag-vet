import {PageHeader} from "@/components/shell/PageHeader";
import {VerifyModeNav} from "@/components/verify/VerifyModeNav";
import {VerifyRedactedPanel} from "@/app/(app)/verify/redacted/VerifyRedactedPanel";

/** WP4.10V item 5 - "Verify a redacted artifact" (staff). A separate page from `/verify` (the
 * unrelated ZK consent-relayer flow, `VerifySessionPanel.tsx`) - this checks an arbitrary
 * `RedactedTagArtifact` document (pasted or uploaded), never starts a relayer session or reads a
 * QR. */
export default function Page() {
  return (
    <>
      <PageHeader
        title="Verify a redacted artifact"
        description="Paste or upload a RedactedTagArtifact JSON document to check whether it is genuine, whether it is currently anchored on chain, and which fields it masks."
      />
      <VerifyModeNav active="/verify/redacted" />
      <VerifyRedactedPanel />
    </>
  );
}
