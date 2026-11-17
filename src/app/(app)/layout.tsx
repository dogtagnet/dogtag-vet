import type {ReactNode} from "react";
import {redirect} from "next/navigation";
import {auth} from "@/auth";
import {AppShell} from "@/components/shell/AppShell";

/** The authenticated staff app shell: sidebar nav + topbar, wraps every `/dashboard`, `/setup`,
 * `/settings`, `/calendar`, ... route. Middleware already gates these paths, but a server-side
 * session check here is cheap defense in depth and is what supplies the signed-in user's
 * email/role to the shell. */
export default async function AppLayout({children}: {children: ReactNode}) {
  const session = await auth();
  if (!session?.user?.email || !session.user.staffId) {
    redirect("/sign-in");
  }

  return (
    <AppShell email={session.user.email} role={session.user.role ?? "staff"}>
      {children}
    </AppShell>
  );
}
