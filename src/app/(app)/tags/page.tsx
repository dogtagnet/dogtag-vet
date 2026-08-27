import Link from "next/link";
import {PageHeader} from "@/components/shell/PageHeader";
import {Button} from "@/components/ui/controls";
import {TagsTable} from "@/app/(app)/tags/TagsTable";

export default function Page() {
  return (
    <>
      <PageHeader
        title="Tags"
        description="Every issued DogTag, reconciled from this clinic's clone."
        action={
          <Link href="/tags/issue">
            <Button>Issue tag</Button>
          </Link>
        }
      />
      <TagsTable />
    </>
  );
}
