"use client";

import {HashCell} from "@/components/ui/HashCell";
import {recordLeafDisplayValue, recordLeafLabel, RECORD_CALENDAR_DATE_KEY_PATHS} from "@/lib/records/leafLabels";
import {formatIsoCalendarDate} from "@/lib/records/validity";
import {KNOWN_RECORD_STANDARDS} from "@/lib/records/standards";
import type {RecordArtifactLeaf, RecordConformsTo} from "@/lib/models/RecordArtifact";

const HEX_VALUE_RE = /^0x[0-9a-fA-F]+$/;

function conformsToName(entry: RecordConformsTo): string {
  return KNOWN_RECORD_STANDARDS.find((s) => s.id === entry.standard && s.version === entry.version)?.name ?? `${entry.standard} (${entry.version})`;
}

/**
 * Plan section 11.2 V4's detail view: "all leaves via a dynamic key/value renderer with dictionary
 * labels" - DYNAMIC because it renders whatever `leaves` this particular record actually carries
 * (never a fixed, hand-listed form matching only today's `VaccinationRecordForm` shape), so a future
 * record type - or a masked export missing some leaves - still renders every leaf it DOES have.
 * "Dictionary labels" via `lib/records/leafLabels.ts`'s hand-maintained keyPath -> label map
 * (falling back to a generic title-cased rendering for anything unlisted).
 *
 * `conformsTo` renders separately, below the leaf grid, not as a leaf itself (it is UNCOMMITTED -
 * specs/leaf-commitment.md section 16 - never part of `leaves`/the Merkle root) - advisor review
 * finding: `IssueRecordForm`'s checkboxes had no readback anywhere, so a vet could never see what
 * they had claimed once the form closed.
 */
export function RecordDetailPanel({leaves, conformsTo}: {leaves: RecordArtifactLeaf[]; conformsTo: RecordConformsTo[]}) {
  return (
    <div className="space-y-4">
      {leaves.length === 0 ? (
        <p className="text-body text-ink-faint">No disclosed leaves on this record.</p>
      ) : (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          {leaves.map((leaf) => (
            <div key={leaf.keyPath}>
              <dt className="text-caption font-medium uppercase tracking-wide text-ink-muted">{recordLeafLabel(leaf.keyPath)}</dt>
              <dd className="mt-0.5 text-body text-ink">
                {RECORD_CALENDAR_DATE_KEY_PATHS.has(leaf.keyPath) ? (
                  formatIsoCalendarDate(leaf.value)
                ) : HEX_VALUE_RE.test(leaf.value) ? (
                  <HashCell value={leaf.value} kind="doc" />
                ) : (
                  recordLeafDisplayValue(leaf.keyPath, leaf.value)
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {conformsTo.length > 0 && (
        <div>
          <dt className="text-caption font-medium uppercase tracking-wide text-ink-muted">Conforms to</dt>
          <dd className="mt-0.5 text-body text-ink">{conformsTo.map(conformsToName).join(", ")}</dd>
        </div>
      )}
    </div>
  );
}
