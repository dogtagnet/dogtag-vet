"use client";

import {useRouter, useSearchParams, usePathname} from "next/navigation";
import {Input, Select} from "@/components/ui/controls";

/** Filter bar for `/activity` - type (the on-chain event name) and a clinic-local date range,
 * per wp4-vet.md's "Timeline component, tx links, filters". State lives in the URL, same
 * convention as `AppointmentFilters`, so the list page stays a plain server component. `types` is
 * the set of event names actually present in this clinic's own activity log (derived server-side
 * via `ChainActivity.distinct("type")`) rather than a hardcoded list - it can never drift out of
 * sync with whatever the worker's follower has actually recorded. */
export function ActivityFilters({types}: {types: string[]}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function setParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams);
    if (value) params.set(key, value);
    else params.delete(key);
    router.replace(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <Select
        value={searchParams.get("type") ?? ""}
        onChange={(e) => setParam("type", e.target.value)}
        className="w-auto"
        aria-label="Filter by event type"
      >
        <option value="">All event types</option>
        {types.map((type) => (
          <option key={type} value={type}>
            {type}
          </option>
        ))}
      </Select>
      <Input
        type="date"
        value={searchParams.get("from") ?? ""}
        onChange={(e) => setParam("from", e.target.value)}
        className="w-auto"
        aria-label="From date"
      />
      <Input
        type="date"
        value={searchParams.get("to") ?? ""}
        onChange={(e) => setParam("to", e.target.value)}
        className="w-auto"
        aria-label="To date"
      />
    </div>
  );
}
