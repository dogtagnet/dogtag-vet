"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import {navGroups} from "@/components/shell/nav";

export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav className="flex h-full w-60 shrink-0 flex-col gap-6 overflow-y-auto border-r border-border bg-surface px-3 py-5">
      <Link href="/dashboard" className="px-2 text-emphasized font-semibold text-ink">
        dogtag<span className="text-brand">-vet</span>
      </Link>
      {navGroups.map((group) => (
        <div key={group.label}>
          <p className="px-2 pb-1.5 text-caption font-medium uppercase tracking-wide text-ink-faint">
            {group.label}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={`block rounded-control px-2 py-1.5 text-body transition-colors ${
                      active
                        ? "bg-brand-soft font-medium text-brand"
                        : "text-ink-muted hover:bg-surface-2 hover:text-ink"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
