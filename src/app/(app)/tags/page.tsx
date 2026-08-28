import Link from "next/link";
import {PageHeader} from "@/components/shell/PageHeader";
import {Button} from "@/components/ui/controls";
import {connectToDatabase} from "@/lib/db";
import {getBookingSettings} from "@/lib/models/Availability";
import {TagsTable} from "@/app/(app)/tags/TagsTable";

export default async function Page() {
  await connectToDatabase();
  const {timezone} = await getBookingSettings();

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
      <TagsTable timeZone={timezone} />
    </>
  );
}
