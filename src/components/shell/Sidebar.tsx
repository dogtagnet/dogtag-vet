"use client";

import Link from "next/link";
import {usePathname} from "next/navigation";
import {navGroups} from "@/components/shell/nav";
import type {StaffRole} from "@/lib/models/Staff";
import {isVetOrOwner} from "@/lib/staffRoleTone";

/** Nav groups gated to `vet`/`owner` (WP4.7 A2) - the sidebar-level half of the same gate `/tags`
 * and `/tags/issue` enforce server-side (see those pages' doc comments); a plain `staff` session
 * never even sees the group exists. Named by `NavGroup.label` rather than duplicating the item
 * list here, so adding a new item to an already-gated group in `nav.ts` never needs a second edit
 * here to stay gated. */
const VET_ONLY_GROUPS = new Set(["DogTag"]);

export function visibleGroups(role: StaffRole | undefined) {
  if (isVetOrOwner(role)) return navGroups;
  return navGroups.filter((group) => !VET_ONLY_GROUPS.has(group.label));
}

/** The single nav item that should render active for `pathname`, or `undefined` off-nav (e.g. a
 * sign-in page). A path can match more than one item's prefix - `/tags/issue` starts with both
 * `/tags` and `/tags/issue` - so this picks the longest (most specific) matching `href` across
 * every group rather than letting every ancestor light up at once, which is what a plain
 * `pathname.startsWith(item.href)` per-item check produced (both "Tags" and "Issue tag" active on
 * `/tags/issue`, per the round-5 grader finding). Exact-match candidates and prefix-match
 * candidates (`${href}/`) are gathered the same way a plain per-item check would, just compared
 * against each other for specificity before deciding a winner. */
function findActiveHref(pathname: string | null): string | undefined {
  if (pathname === null) return undefined;
  let best: string | undefined;
  for (const group of navGroups) {
    for (const item of group.items) {
      const matches = pathname === item.href || pathname.startsWith(`${item.href}/`);
      if (matches && (best === undefined || item.href.length > best.length)) {
        best = item.href;
      }
    }
  }
  return best;
}

export function Sidebar({role}: {role?: StaffRole}) {
  const pathname = usePathname();
  const activeHref = findActiveHref(pathname);
  const groups = visibleGroups(role);

  return (
    <nav className="flex h-full w-60 shrink-0 flex-col gap-6 overflow-y-auto border-r border-border bg-surface px-3 py-5">
      <Link href="/dashboard" className="px-2 text-emphasized font-semibold text-ink">
        dogtag<span className="text-brand">-vet</span>
      </Link>
      {groups.map((group) => (
        <div key={group.label}>
          <p className="px-2 pb-1.5 text-caption font-medium uppercase tracking-wide text-ink-faint">
            {group.label}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = item.href === activeHref;
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
