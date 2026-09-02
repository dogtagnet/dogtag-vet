import Link from "next/link";
import {AddressChip} from "@/components/ui/AddressChip";
import {HashCell} from "@/components/ui/HashCell";
import {MonoValue} from "@/components/ui/MonoValue";
import {StatusBadge} from "@/components/ui/StatusBadge";
import {ShareTagDataAction} from "@/components/tags/ShareTagDataAction";
import {dogTagStatusLabel, dogTagStatusTone} from "@/lib/tagStatusTone";
import type {DogTagInfo} from "@/lib/models/Pet";

/**
 * Surfaces `Pet.dogTag` on the pet's own record - design-system.md principle 3 ("everything with
 * a lifecycle shows a status badge") and principle 2 ("on-chain facts look on-chain"). Read-only
 * for LIFECYCLE STATE changes: revoke/reactivate/replace stay on `/tags`, this card only links
 * there. `ShareTagDataAction` (WP4.9 section 2.2) is deliberately an exception to that rule - it
 * never changes the tag's own state (no revoke/reactivate/replace-shaped write happens), it only
 * hands the OWNER a one-time copy of data already on file, so it lives directly on this card rather
 * than being yet another "go to /tags" link.
 */
export function PetTagCard({petId, dogTag = {}}: {petId: string; dogTag?: DogTagInfo}) {
  const hasTag = Boolean(dogTag.dogTagIdDec);

  if (!hasTag) {
    return (
      <section className="rounded-card border border-border bg-surface p-5 shadow-card">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-section-title text-ink">DogTag</h3>
          <StatusBadge tone="neutral" label="No tag issued" />
        </div>
        <p className="mb-4 text-body text-ink-muted">This pet has no DogTag on chain yet.</p>
        <Link href="/tags/issue" className="text-body font-medium text-link hover:underline">
          Issue a tag
        </Link>
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
          Imported from a mobile booking&apos;s tag claim, verified on chain against another clinic&apos;s issuance - this clinic did not
          issue it and cannot revoke, reactivate, or replace it here.
        </p>
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
      <div className="mt-4 flex flex-wrap items-center gap-4">
        {!dogTag.external && (
          <Link href="/tags" className="text-body font-medium text-link hover:underline">
            Manage in Tags
          </Link>
        )}
        {dogTag.status !== "revoked" && <ShareTagDataAction petId={petId} />}
      </div>
    </section>
  );
}
