"use client";

import {useRouter, useSearchParams, usePathname} from "next/navigation";
import {Input, Select} from "@/components/ui/controls";
import {SearchBox} from "@/components/ui/SearchBox";
import {appointmentSourceLabel, appointmentSources, appointmentStatusLabel, appointmentStatuses} from "@/lib/appointmentTone";

/** Filter bar for `/appointments`'s query vocabulary (`q, status, source, from, to` - `source`
 * added WP4.4) - all state lives in the URL so the list page stays a plain server component. */
export function AppointmentFilters() {
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
      <SearchBox placeholder="Search by client or pet name" />
      <Select
        value={searchParams.get("status") ?? ""}
        onChange={(e) => setParam("status", e.target.value)}
        className="w-auto"
        aria-label="Filter by status"
      >
        <option value="">All statuses</option>
        {appointmentStatuses.map((status) => (
          <option key={status} value={status}>
            {appointmentStatusLabel[status]}
          </option>
        ))}
      </Select>
      <Select
        value={searchParams.get("source") ?? ""}
        onChange={(e) => setParam("source", e.target.value)}
        className="w-auto"
        aria-label="Filter by source"
      >
        <option value="">All sources</option>
        {appointmentSources.map((source) => (
          <option key={source} value={source}>
            {appointmentSourceLabel[source]}
          </option>
        ))}
      </Select>
      <Input
        type="date"
        value={searchParams.get("fromDate") ?? ""}
        onChange={(e) => setParam("fromDate", e.target.value)}
        className="w-auto"
        aria-label="From date"
      />
      <Input
        type="date"
        value={searchParams.get("toDate") ?? ""}
        onChange={(e) => setParam("toDate", e.target.value)}
        className="w-auto"
        aria-label="To date"
      />
    </div>
  );
}
