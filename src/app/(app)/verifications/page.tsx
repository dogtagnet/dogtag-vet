import {PageHeader} from "@/components/shell/PageHeader";
import {DataTable} from "@/components/ui/DataTable";
import {HashCell} from "@/components/ui/HashCell";
import {formatUnixSeconds} from "@/lib/format";
import {connectToDatabase} from "@/lib/db";
import {VerifySession, type VerifySessionDoc} from "@/lib/models/VerifySession";

/** `/verifications` - v1 VerificationLog vocabulary: disclosed keyPaths never values, never a
 * subject wallet (wp4-vet.md). `VerifySessionDoc` never stores a subject/owner wallet address at
 * all, so there is nothing to accidentally render here even if a future field is added carelessly
 * elsewhere - only `relayerAddress` (the vet-side actor) and `disclosedKeyPaths` are shown. */
export default async function Page() {
  await connectToDatabase();
  const sessions = await VerifySession.find({status: "recorded"})
    .sort({updatedAt: -1})
    .limit(200)
    .lean<VerifySessionDoc[]>();

  return (
    <>
      <PageHeader title="Verification history" description="Recorded consent verifications for this clinic." />
      <DataTable
        columns={[
          {key: "when", header: "When", render: (s: VerifySessionDoc) => formatUnixSeconds(Math.floor(new Date(s.updatedAt).getTime() / 1000))},
          {key: "purpose", header: "Purpose", render: (s: VerifySessionDoc) => s.purpose},
          {key: "recordType", header: "Record type", render: (s: VerifySessionDoc) => s.recordType},
          {key: "dogTagId", header: "dogTagId", mono: true, render: (s: VerifySessionDoc) => s.challenge.dogTagId},
          {key: "relayer", header: "Relayer", render: (s: VerifySessionDoc) => <HashCell value={s.relayerAddress} chain="roax" kind="doc" /> },
          {key: "tx", header: "Tx", render: (s: VerifySessionDoc) => (s.txHash ? <HashCell value={s.txHash} chain="roax" kind="tx" /> : "-")},
          {
            key: "disclosed",
            header: "Disclosed keyPaths",
            render: (s: VerifySessionDoc) => (s.disclosedKeyPaths.length > 0 ? s.disclosedKeyPaths.join(", ") : "-"),
          },
        ]}
        rows={sessions}
        getRowKey={(s) => s.sessionId}
        emptyMessage="No verifications recorded yet."
      />
    </>
  );
}
