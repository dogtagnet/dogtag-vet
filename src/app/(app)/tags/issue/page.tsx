import {PageHeader} from "@/components/shell/PageHeader";
import {TagIssueWizard} from "@/app/(app)/tags/issue/TagIssueWizard";

export default function Page() {
  return (
    <>
      <PageHeader title="Issue tag" description="Mint a new DogTag for a client's pet." />
      <TagIssueWizard />
    </>
  );
}
