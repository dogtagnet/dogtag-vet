/**
 * The pet page's "Owners" card (V1) - chain-authoritative for active-vs-revoked, Mongo-only for
 * commitment -> client identity (advisor guidance, `docs/DELEGATION.md` section 4.5: "any consumer
 * ... that re-derives its view of 'who is currently a secondary owner' from a live chain read - the
 * vet CRM ... - stops showing the revoked party immediately"; section 7: "every consumer is
 * expected to read live rather than cache"). A Mongo-only view would show a secondary revoked by a
 * DIFFERENT clinic (Kenneth's decision, plan section 9 item 2: any Active clinic may revoke) as
 * still active forever - this function exists specifically so that never happens.
 *
 * Pure (no I/O) so it is directly unit-testable - the caller supplies this clinic's own
 * `DelegationSession` history (Mongo: who is `clientId` X, when was X added, by which clinic) and
 * the LIVE `delegationLeaves` chain read (a `Set` of currently-active commitments, or `null` if the
 * chain could not be read at all).
 */
export interface ConfirmedAddRecord {
  commitment: string; // lowercase hex32
  clientId: string;
  clinicName: string;
  at: number; // unix seconds
}

export interface ConfirmedRevokeRecord {
  commitment: string;
  at: number;
}

export type SecondaryOwnerRowStatus = "active" | "revoked" | "active_unverified" | "revoked_unverified";

export interface SecondaryOwnerRow {
  commitment: string;
  status: SecondaryOwnerRowStatus;
  /** Absent when this commitment is active on chain but this clinic has no local record of who
   * added it (`docs/DELEGATION.md` section 4.5: any Active clinic may add on any tag) - shown
   * honestly as "added at another clinic", never guessed or hidden. */
  clientId?: string;
  addedByClinic?: string;
  addedAt?: number;
  revokedAt?: number;
}

/**
 * Joins this clinic's OWN `DelegationSession` history against the live on-chain active set.
 * `chainActiveCommitments === null` means the chain could not be read at all - every row then
 * falls back to Mongo's own last-known outcome, honestly suffixed `_unverified` (never silently
 * presented as `"active"`/`"revoked"` when this app could not actually confirm it right now,
 * mirroring `resolveOperatorStatus`'s own `"unreadable"` honesty convention).
 *
 * A commitment active on chain with no matching `confirmedAdds` row (added at another clinic, or
 * added before this clinic's own `DelegationSession` history began) still gets a row - `clientId`/
 * `addedByClinic` simply absent - so this clinic's Owners card can never show fewer active
 * secondaries than the chain's own `secondaryCount` without saying why.
 */
export function buildSecondaryOwnerRows(
  confirmedAdds: ConfirmedAddRecord[],
  confirmedRevokes: ConfirmedRevokeRecord[],
  chainActiveCommitments: Set<string> | null,
): SecondaryOwnerRow[] {
  const revokedAtByCommitment = new Map<string, number>();
  for (const r of confirmedRevokes) {
    const existing = revokedAtByCommitment.get(r.commitment);
    if (existing === undefined || r.at > existing) revokedAtByCommitment.set(r.commitment, r.at);
  }

  const rows = new Map<string, SecondaryOwnerRow>();

  for (const add of confirmedAdds) {
    const revokedAt = revokedAtByCommitment.get(add.commitment);
    const mongoSaysActive = revokedAt === undefined || revokedAt < add.at;
    let status: SecondaryOwnerRowStatus;
    if (chainActiveCommitments === null) {
      status = mongoSaysActive ? "active_unverified" : "revoked_unverified";
    } else {
      status = chainActiveCommitments.has(add.commitment) ? "active" : "revoked";
    }
    // A later add (re-add after revoke, docs/DELEGATION.md section 4.2 - "treated as a brand-new
    // history entry") wins the row if this commitment appears more than once in this clinic's own
    // history - keep the most recent add's own metadata.
    const existing = rows.get(add.commitment);
    if (!existing || add.at > (existing.addedAt ?? -Infinity)) {
      rows.set(add.commitment, {
        commitment: add.commitment,
        status,
        clientId: add.clientId,
        addedByClinic: add.clinicName,
        addedAt: add.at,
        revokedAt: status === "revoked" || status === "revoked_unverified" ? revokedAt : undefined,
      });
    }
  }

  if (chainActiveCommitments !== null) {
    for (const commitment of chainActiveCommitments) {
      if (!rows.has(commitment)) {
        rows.set(commitment, {commitment, status: "active"});
      }
    }
  }

  return Array.from(rows.values()).sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
}
