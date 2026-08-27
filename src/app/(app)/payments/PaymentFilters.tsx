"use client";

import {useRouter, useSearchParams, usePathname} from "next/navigation";
import {Select} from "@/components/ui/controls";
import {paymentStatusLabel, paymentStatuses} from "@/lib/paymentTone";

/** Filter bar for `/payments` - status only, mirroring `AppointmentFilters`'s "state lives in the
 * URL so the list page stays a plain server component" pattern. */
export function PaymentFilters() {
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
        value={searchParams.get("status") ?? ""}
        onChange={(e) => setParam("status", e.target.value)}
        className="w-auto"
        aria-label="Filter by status"
      >
        <option value="">All statuses</option>
        {paymentStatuses.map((status) => (
          <option key={status} value={status}>
            {paymentStatusLabel[status]}
          </option>
        ))}
      </Select>
    </div>
  );
}
