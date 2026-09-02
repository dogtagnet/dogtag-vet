import Link from "next/link";
import {redirect} from "next/navigation";
import {PageHeader} from "@/components/shell/PageHeader";
import {Button} from "@/components/ui/controls";
import {auth} from "@/auth";
import {connectToDatabase} from "@/lib/db";
import {getBookingSettings} from "@/lib/models/Availability";
import {isVetOrOwner} from "@/lib/staffRoleTone";
import {TagsTable} from "@/app/(app)/tags/TagsTable";
import {ImportTagSection} from "@/app/(app)/tags/ImportTagSection";

/** DogTag issuance surface - WP4.7 A2: gated to `vet`/`owner` (the app-side half of D4's gate;
 * the chain's own operator whitelist is the real authority, see `requireVetSession`'s doc
 * comment). A plain `staff` session is redirected to the dashboard with a clear explanatory
 * notice rather than a bare 403 - the sidebar also hides this whole nav group for them
 * (`Sidebar.tsx`), so reaching this URL at all means a stale link or a manual visit. */
export default async function Page() {
  const session = await auth();
  if (!isVetOrOwner(session?.user?.role)) {
    redirect("/dashboard?notice=vet-required");
  }

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
      <ImportTagSection />
      <TagsTable timeZone={timezone} />
    </>
  );
}
