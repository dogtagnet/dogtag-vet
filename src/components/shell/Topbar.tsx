"use client";

import {signOut} from "next-auth/react";
import {ThemeToggle} from "@/components/ui/ThemeToggle";
import {Button} from "@/components/ui/controls";
import {StatusBadge} from "@/components/ui/StatusBadge";
import type {StaffRole} from "@/lib/models/Staff";

export interface TopbarProps {
  email: string;
  role: StaffRole;
}

export function Topbar({email, role}: TopbarProps) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface px-6">
      <div />
      <div className="flex items-center gap-4">
        <ThemeToggle />
        <div className="flex items-center gap-2">
          <span className="text-body text-ink">{email}</span>
          <StatusBadge tone={role === "owner" ? "info" : "neutral"} label={role} />
        </div>
        <Button variant="secondary" onClick={() => signOut({redirectTo: "/"})}>
          Sign out
        </Button>
      </div>
    </header>
  );
}
