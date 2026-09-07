import {Banner} from "@/components/ui/Banner";
import {HashCell} from "@/components/ui/HashCell";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {AddSecondaryOwnerAction} from "@/components/pets/AddSecondaryOwnerAction";
import {RevokeSecondaryOwnerAction} from "@/components/pets/RevokeSecondaryOwnerAction";
import {formatUnixSeconds} from "@/lib/format";
import type {DisplaySecondaryOwnerRow, OwnersCardData} from "@/lib/delegation/ownersCardData";

const STATUS_BADGE: Record<DisplaySecondaryOwnerRow["status"], {tone: "ok" | "danger" | "warn"; label: string}> = {
  active: {tone: "ok", label: "Active"},
  revoked: {tone: "danger", label: "Revoked"},
  active_unverified: {tone: "warn", label: "Active (unverified)"},
  revoked_unverified: {tone: "warn", label: "Revoked (unverified)"},
};

/**
 * WP4.15 multi-owner (PLANNED) - the pet page's "Owners" card (plan section 14.1 item V1):
 * primary badge, secondary list with status, Add/Revoke actions gated on a vet/owner session.
 * Chain-authoritative for active-vs-revoked (`docs/DELEGATION.md` section 4.5 - see
 * `lib/delegation/ownersCard.ts`'s own doc comment for the full reasoning); this clinic's own
 * `DelegationSession` history is the only source for WHO a commitment belongs to, so a secondary
 * added at another clinic still shows as an active row, just with no name attached.
 */
export function OwnersCard({
  petId,
  dogTagIdField,
  primaryOwnerLabel,
  data,
  canManage,
  timeZone,
}: {
  petId: string;
  dogTagIdField?: string;
  /** `undefined` when this pet has no primary owner recorded (legacy - back-compat, never
   * guessed) vs a display string when it does. */
  primaryOwnerLabel?: string;
  data: OwnersCardData;
  canManage: boolean;
  timeZone: string;
}) {
  const hasTag = Boolean(dogTagIdField);

  return (
    <section className="rounded-card border border-border bg-surface p-5 shadow-card">
      <div className="mb-4 flex items-center justify-between gap-2">
        {/* NOT "Owners" - `PetForm.tsx`'s pre-existing "Owners" FormSection already owns that
            exact heading for the unrelated many-to-many CRM contacts list (`ownerClientIds`,
            OwnerPicker). This card is about DogTag primary/secondary ownership specifically -
            a real naming collision two sections on the same page would otherwise share. The
            helper text right below makes the distinction visible on the page itself, not just to
            a code reader - `PetForm`'s section renders unconditionally further down this same
            page (`pets/[id]/page.tsx`), so a vet skimming the two headings side by side needs the
            one-line pointer as much as this comment. */}
        <h3 className="text-section-title text-ink">DogTag owners</h3>
      </div>
      <p className="mb-4 text-caption text-ink-faint">
        Chain-verified DogTag ownership - separate from the client contacts list further down this page.
      </p>

      {!data.chainVerified && (
        <Banner tone="warn" title="Could not verify current secondary owners">
          <p>The chain could not be reached just now - the statuses below reflect this clinic&apos;s own last-known records and are marked unverified.</p>
        </Banner>
      )}

      <dl className="mb-4">
        <div className="flex items-center justify-between gap-2 border-b border-border py-2">
          <dt className="text-body text-ink-faint">Primary owner</dt>
          <dd className="flex items-center gap-2">
            {primaryOwnerLabel ? (
              <span className="text-body font-medium text-ink">{primaryOwnerLabel}</span>
            ) : (
              <span className="text-body text-ink-faint italic">Primary not recorded</span>
            )}
            <StatusBadge tone="info" label="Primary" />
          </dd>
        </div>
      </dl>

      {data.secondaries.length > 0 && (
        <ul className="mb-4 space-y-2">
          {data.secondaries.map((row) => {
            const badge = STATUS_BADGE[row.status];
            const isActive = row.status === "active" || row.status === "active_unverified";
            return (
              <li key={row.commitment} className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-border p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-body font-medium text-ink">{row.clientName ?? "Added at another clinic"}</span>
                    <StatusBadge tone={badge.tone} label={badge.label} />
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-faint">
                    <HashCell value={row.commitment} kind="doc" />
                    {row.addedByClinic && <span>Added by {row.addedByClinic}</span>}
                    {row.addedAt !== undefined && <span>{formatUnixSeconds(row.addedAt, timeZone)}</span>}
                  </div>
                </div>
                {canManage && isActive && dogTagIdField && (
                  <RevokeSecondaryOwnerAction petId={petId} dogTagIdField={dogTagIdField} commitment={row.commitment} clientName={row.clientName} />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canManage && hasTag && dogTagIdField && (
        <div className="flex flex-wrap items-start gap-4">
          <AddSecondaryOwnerAction petId={petId} dogTagIdField={dogTagIdField} disabled={!data.delegationConfigured} />
        </div>
      )}
      {canManage && !data.delegationConfigured && hasTag && (
        <p className="mt-2 text-caption text-ink-faint">Multi-owner tags are not configured on this deployment yet.</p>
      )}
      {canManage && !hasTag && (
        <p className="text-body text-ink-faint">Issue a tag before adding secondary owners.</p>
      )}
    </section>
  );
}
