import {DataTable} from "@/components/ui/DataTable";
import {FormSection} from "@/components/ui/FormSection";
import {formatUnixSeconds} from "@/lib/format";
import type {AbuseLogEntry} from "@/lib/abuseLog";
import {ABUSE_LOG_RETENTION_DAYS} from "@/lib/models/AbuseLog";

const reasonLabels: Record<AbuseLogEntry["reason"], string> = {
  rate_limited: "Rate limited",
  body_too_large: "Body too large",
};

/** Read-only view of `src/lib/abuseLog.ts` - the record of rejected public-API traffic
 * (wp4-vet.md's "Public API protection" abuse log). Entries self-prune after
 * `ABUSE_LOG_RETENTION_DAYS`, so this is always a recent-activity window, not a permanent record. */
export function AbuseLogSection({entries, timeZone}: {entries: AbuseLogEntry[]; timeZone: string}) {
  return (
    <FormSection
      title="Public API abuse log"
      helperText={`Rejected requests against the public routes, most recent first. Entries expire automatically after ${ABUSE_LOG_RETENTION_DAYS} days.`}
    >
      <DataTable
        columns={[
          {key: "route", header: "Route", render: (r: AbuseLogEntry) => r.route},
          {key: "client", header: "Client", mono: true, render: (r: AbuseLogEntry) => r.clientKey},
          {key: "reason", header: "Reason", render: (r: AbuseLogEntry) => reasonLabels[r.reason]},
          {key: "count", header: "Count", align: "right", render: (r: AbuseLogEntry) => r.count},
          {
            key: "lastSeen",
            header: "Last seen",
            render: (r: AbuseLogEntry) => formatUnixSeconds(Math.floor(new Date(r.lastSeenAt).getTime() / 1000), timeZone),
          },
        ]}
        rows={entries}
        getRowKey={(r) => `${r.route}:${r.clientKey}:${r.reason}`}
        emptyMessage="No rejected public requests in the retention window."
      />
    </FormSection>
  );
}
