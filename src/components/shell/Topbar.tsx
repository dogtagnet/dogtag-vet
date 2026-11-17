"use client";

import {signOut} from "next-auth/react";
import {ThemeToggle} from "@/components/ui/ThemeToggle";
import {Button} from "@/components/ui/controls";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {staffRoleLabel, staffRoleTone} from "@/lib/staffRoleTone";
import type {StaffRole} from "@/lib/models/Staff";

export interface TopbarProps {
  email: string;
  role: StaffRole;
  /** Opens the nav drawer (shown only below the `md` breakpoint, where the sidebar is off-canvas). */
  onMenu?: () => void;
  menuOpen?: boolean;
}

export function Topbar({email, role, onMenu, menuOpen = false}: TopbarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface px-4 md:px-6">
      <button
        type="button"
        onClick={onMenu}
        aria-label="Open navigation"
        aria-controls="app-sidebar"
        aria-expanded={menuOpen}
        className="inline-flex h-9 w-9 items-center justify-center rounded-control border border-border text-ink hover:bg-surface-2 md:hidden"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      <div className="hidden md:block" />
      <div className="flex min-w-0 items-center gap-2 md:gap-4">
        <ThemeToggle />
        <div className="flex min-w-0 items-center gap-2">
          <span className="hidden truncate text-body text-ink sm:inline">{email}</span>
          <span className="hidden sm:inline-flex">
            <StatusBadge tone={staffRoleTone[role]} label={staffRoleLabel[role]} />
          </span>
        </div>
        <Button variant="secondary" className="whitespace-nowrap" onClick={() => signOut({redirectTo: "/"})}>
          Sign out
        </Button>
      </div>
    </header>
  );
}
