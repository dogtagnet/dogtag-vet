import type {ReactNode} from "react";
import {redirect} from "next/navigation";
import {auth} from "@/auth";
import {Sidebar} from "@/components/shell/Sidebar";
import {Topbar} from "@/components/shell/Topbar";

/** The authenticated staff app shell: sidebar nav + topbar, wraps every `/dashboard`, `/setup`,
 * `/settings`, `/calendar`, ... route. Middleware already gates these paths, but a server-side
 * session check here is cheap defense in depth and is what supplies the signed-in user's
 * email/role to the shell. */
export default async function AppLayout({children}: {children: ReactNode}) {
  const session = await auth();
  if (!session?.user?.email) {
    redirect("/sign-in");
  }

  return (
    <div className="flex h-dvh bg-bg">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar email={session.user.email} role={session.user.role ?? "staff"} />
        <main className="flex-1 overflow-y-auto px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
