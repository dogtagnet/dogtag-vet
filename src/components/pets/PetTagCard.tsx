import Link from "next/link";
import {AddressChip} from "@/components/ui/AddressChip";
import {Banner} from "@/components/ui/Banner";
import {HashCell} from "@/components/ui/HashCell";
import {MonoValue} from "@/components/ui/MonoValue";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {ShareTagDataAction} from "@/components/tags/ShareTagDataAction";
import {MaskedExportAction} from "@/components/tags/MaskedExportAction";
import {ImportTagAction} from "@/components/tags/ImportTagAction";
import {dogTagStatusLabel, dogTagStatusTone} from "@/lib/tagStatusTone";
import {formatUnixSeconds} from "@/lib/format";
import type {DogTagInfo} from "@/lib/models/Pet";

/**
 * Surfaces `Pet.dogTag` on the pet's own record - design-system.md principle 3 ("everything with
 * a lifecycle shows a status badge") and principle 2 ("on-chain facts look on-chain"). Read-only
 * for LIFECYCLE STATE changes: revoke/reactivate/replace stay on `/tags`, this card only links
 * there. `ShareTagDataAction`/`ImportTagAction` (WP4.9 sections 2.2/2.3) are deliberately an
 * exception to that rule - neither changes the CURRENT tag's own state via a revoke/reactivate/
 * replace-shaped write (export hands the owner a one-time copy of data already on file; import
 * only ever attaches when there is no active tag to begin with, per its own gate), so both live
 * directly on this card rather than being yet another "go to /tags" link.
 *
 * SCOPE NOTE (WP4.9V item 6): "audit trail"/provenance for an imported tag is satisfied here by
 * the `external` badge + caption below plus `importConflicts` (both already sourced from
 * `Pet.dogTag`, no extra fetch) - not a separate rendering of the underlying `TagArtifact`'s own
 * fields (source/verifiedAt/issuerClone). That row IS this app's audit record for a custody event
 * (see `lib/tags/artifact.ts`'s own doc comment), it is simply not ALSO duplicated onto this card
 * today; `ChainActivity` was considered and rejected as the audit surface instead, since it
 * requires a real `txHash`/`logIndex` an off-chain import ceremony has neither of.
 */
export function PetTagCard({petId, dogTag = {}, timeZone}: {petId: string; dogTag?: DogTagInfo; timeZone: string}) {
  const hasTag = Boolean(dogTag.dogTagIdDec);

  if (!hasTag) {
    return (
      <section className="rounded-card border border-border bg-surface p-5 shadow-card">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-section-title text-ink">DogTag</h3>
          <StatusBadge tone="neutral" label="No tag issued" />
        </div>
        <p className="mb-4 text-body text-ink-muted">This pet has no DogTag on chain yet.</p>
        {/* WP4.9V FIX ROUND 1 (D6): `items-start`, not `items-center` - `ImportTagAction` replaces
            itself with the full-height `ImportQrPanel` once open, and `items-center` would then
            vertically centre this link against that panel's whole height instead of sitting level
            with its first line. Matches `PhotoCropUpload.tsx`'s own `items-start` row, the
            established idiom for this app's other reveal-bearing rows. */}
        <div className="flex flex-wrap items-start gap-4">
          <Link href="/tags/issue" className="text-body font-medium text-link hover:underline">
            Issue a tag
          </Link>
          <ImportTagAction petId={petId} />
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-card border border-border bg-surface p-5 shadow-card">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h3 className="text-section-title text-ink">DogTag</h3>
        <div className="flex items-center gap-2">
          {dogTag.external && <StatusBadge tone="info" label="External" />}
          {dogTag.status ? (
            <StatusBadge tone={dogTagStatusTone[dogTag.status]} label={dogTagStatusLabel[dogTag.status]} />
          ) : (
            <StatusBadge tone="neutral" label="Unknown" />
          )}
        </div>
      </div>
      {dogTag.external && (
        <p className="mb-4 -mt-2 text-caption text-ink-faint">
          Imported (via a mobile booking&apos;s tag claim, or the tag-data import ceremony), verified on chain against another
          clinic&apos;s issuance - this clinic did not issue it and cannot revoke, reactivate, or replace it here.
        </p>
      )}
      {dogTag.importConflicts && dogTag.importConflicts.fields.length > 0 && (
        <Banner tone="warn" title="Data mismatch at import time">
          <p className="mb-2">
            When this tag was imported on {formatUnixSeconds(dogTag.importConflicts.detectedAt, timeZone)}, the following fields
            disagreed with this pet&apos;s existing record. This clinic&apos;s own values were kept - nothing was overwritten.
          </p>
          <ul className="list-inside list-disc space-y-1">
            {dogTag.importConflicts.fields.map((c) => (
              <li key={c.field}>
                <span className="font-medium">{c.field}</span>: this record says &quot;{c.petValue}&quot;, the imported tag claimed
                &quot;{c.verifiedValue}&quot;.
              </li>
            ))}
          </ul>
        </Banner>
      )}
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <dt className="text-caption text-ink-faint">Tag id</dt>
          <dd className="text-body text-ink">{dogTag.dogTagIdDec}</dd>
        </div>
        {dogTag.root && (
          <div>
            <dt className="text-caption text-ink-faint">Root</dt>
            <dd>
              <HashCell value={dogTag.root} kind="root" />
            </dd>
          </div>
        )}
        {dogTag.issuedTx && (
          <div>
            <dt className="text-caption text-ink-faint">Issued tx</dt>
            <dd>
              <HashCell value={dogTag.issuedTx} chain="roax" kind="tx" />
            </dd>
          </div>
        )}
        {dogTag.cloneAddress && (
          <div>
            <dt className="text-caption text-ink-faint">Clone address</dt>
            <dd>
              <AddressChip address={dogTag.cloneAddress} chain="roax" />
            </dd>
          </div>
        )}
        <div>
          <dt className="text-caption text-ink-faint">Issuer attestation</dt>
          <dd className="flex items-center gap-2">
            <StatusBadge
              tone={dogTag.attestation ? "ok" : "warn"}
              label={dogTag.attestation ? "Attested" : "Not attested"}
            />
            {dogTag.attestation && <MonoValue value={dogTag.attestation.issuerSigner} label="Signer" />}
          </dd>
        </div>
      </dl>
      {/* WP4.9V FIX ROUND 1 (D6): `items-start`, not `items-center` - see the no-tag branch's
          identical comment above. `ShareTagDataAction`/`ImportTagAction` each replace themselves
          with a full-height panel once open, so `items-center` was vertically centring this link
          against the whole panel instead of sitting level with its first line. */}
      <div className="mt-4 flex flex-wrap items-start gap-4">
        {!dogTag.external && (
          <Link href="/tags" className="text-body font-medium text-link hover:underline">
            Manage in Tags
          </Link>
        )}
        {dogTag.status !== "revoked" ? (
          <>
            <ShareTagDataAction petId={petId} />
            <MaskedExportAction petId={petId} />
          </>
        ) : (
          <ImportTagAction petId={petId} />
        )}
      </div>
    </section>
  );
}
