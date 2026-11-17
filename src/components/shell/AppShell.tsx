"use client";

import {useEffect, useState, type ReactNode} from "react";
import {usePathname} from "next/navigation";
import {Sidebar} from "@/components/shell/Sidebar";
import {Topbar} from "@/components/shell/Topbar";
import type {StaffRole} from "@/lib/models/Staff";

/** The authenticated shell's client half: owns whether the nav drawer is open on narrow screens
 * (below `md` the sidebar is off-canvas behind a menu button; from `md` up it is the static column
 * it always was). Closes on every navigation and on Escape. */
export function AppShell({email, role, children}: {email: string; role: StaffRole; children: ReactNode}) {
  const [navOpen, setNavOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => setNavOpen(false), [pathname]);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  return (
    <div className="flex h-dvh bg-bg">
      <Sidebar role={role} open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar email={email} role={role} onMenu={() => setNavOpen(true)} menuOpen={navOpen} />
        <main className="flex-1 overflow-y-auto px-4 py-6 md:px-6">{children}</main>
      </div>
    </div>
  );
}
