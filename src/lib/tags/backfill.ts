import type {OpenedLeaf} from "@dogtag/standard";
import {identityLeafSelfCheckSubset} from "@/lib/tags/verifier";
import {verifyForProtocolVersion, type CreateTagArtifactInput, type CreateTagArtifactResult} from "@/lib/tags/artifact";
import {DOG_PROFILE_SCHEMA_ID} from "@/lib/tags/schemaIds";

/**
 * The backfill migration (plan section 2.1, checklist item 3c) - closes G2 for every pet that was
 * tagged BEFORE this WP existed: "for every pet with `dogTag.root`, find the bound MintSession
 * carrying that root -> verify -> insert artifact; report (never auto-fix) any session whose
 * stored data no longer recomputes."
 *
 * Pure logic + injected store (the same "flow/store-adapter" pattern as every other multi-step
 * write sequence in this app - `lib/mint/flow.ts`'s `MintFlowStore`, `lib/booking/postBooking.ts`'s
 * `PostBookingStore`), so this is unit-testable with an in-memory fake AND separately provable
 * against a real ephemeral mongod (`tests/unit/models/backfill.integration.test.ts`) without ever
 * touching the live UAT database. `scripts/backfillTagArtifacts.ts` is the only thing that ever
 * calls `mongoBackfillStore` for real, and the CRITICAL LIVE-DB RULE (wp4.9V-progress.md's own
 * header) means the builder/fixer of this WP never runs that script against MONGODB_URI pointed at
 * the live deployment - only Kenneth/the orchestrator does, per the runbook in docs/DEPLOY.md.
 *
 * IDEMPOTENT by construction: a pet whose active artifact's root already matches
 * `Pet.dogTag.root` is skipped entirely (no read of its MintSession, no write) - re-running this
 * script after a partial or fully successful prior run costs one cheap read per already-covered
 * pet and writes nothing new for it.
 */

export interface BackfillPet {
  petId: string;
  dogTagIdDec?: string;
  dogTagIdField?: string;
  /** `Pet.dogTag.root` - always present (the store's `listPetsWithRoot` only ever returns pets
   * that have one). */
  root: string;
  cloneAddress?: string;
  external?: boolean;
}

/** The one MintSession field shape this migration needs - deliberately narrow (not
 * `MintSessionDoc`), matching `lib/mint/reconcile.ts`'s `ReconcileSessionInput` precedent. */
export interface BackfillMintSession {
  dogTagIdDec: string;
  dogTagIdField: string;
  /** `Schema.Types.Mixed` at rest (G1) - passed through untouched. A malformed/corrupted value is
   * never a crash: `verifyLeafCommitment`'s own try/catch (in `createTagArtifact`, transitively)
   * turns anything that cannot even be iterated as leaves into a plain `false` verdict, which this
   * migration reports as a mismatch exactly like any other verification failure - it never needs
   * its own separate shape-validation pass. */
  boundLeaves: unknown;
  reservedLeafHashes?: string[];
  identityLeaves: OpenedLeaf[];
  protocolVersion: string;
}

export interface BackfillStore {
  /** Every `Pet` document that currently carries a `dogTag.root` - issued here or imported, active
   * or revoked (a revoked tag's custody history is still worth having on file). */
  listPetsWithRoot(): Promise<BackfillPet[]>;
  /** The pet's current active artifact's root (lowercased, matching `TagArtifact.root`'s own
   * storage convention), or `null` if it has none yet. */
  findActiveArtifactRoot(petId: string): Promise<string | null>;
  /** The MintSession whose `root` equals this pet's `dogTag.root` exactly (both are written from
   * the identical wire value at bind time - `lib/mint/reconcile.ts::linkPetDogTag` and
   * `lib/mint/mongoStore.ts::commitReady` both persist the SAME `custodialBind` input verbatim, no
   * case transform - so an exact match is correct, never a case-insensitive one). `null` when no
   * session on file carries it at all (a pre-this-app-existing import, a hand-edited Pet record, or
   * genuine data loss). */
  findBoundMintSessionByRoot(root: string): Promise<BackfillMintSession | null>;
  /**
   * WP4.9V FIX ROUND 1 (D2/D1) - the row for this EXACT (lowercased) root, if a `TagArtifact`
   * document already exists for it AT ALL, active or not - `null` when none does. This is what
   * lets DRY-RUN mode predict `inserted` vs `reactivated` vs a cross-pet mismatch WITHOUT writing
   * anything, using the same read the write path's `createTagArtifact` performs internally, rather
   * than a second, separately-maintained guess at what it would find.
   */
  findArtifactByRoot(root: string): Promise<{petId: string; active: boolean} | null>;
  createArtifact(input: CreateTagArtifactInput): Promise<CreateTagArtifactResult>;
}

export interface BackfillMismatch {
  petId: string;
  root: string;
  reason: string;
}

export type BackfillOutcome =
  | {petId: string; root: string; outcome: "already_covered"}
  | {petId: string; root: string; outcome: "inserted"}
  /** WP4.9V FIX ROUND 1 (D1) - a `TagArtifact` row for this exact (petId, root) already existed
   * but was `active: false` (the crash-window repair state `createTagArtifact`'s own doc comment
   * describes) - it was promoted back to `active` rather than inserted fresh. Distinct from
   * `inserted` so an operator reading the report can tell "this pet had zero rows for its current
   * root" apart from "this pet had a stale inactive row for its current root", even though both
   * leave the pet correctly covered. */
  | {petId: string; root: string; outcome: "reactivated"}
  | {petId: string; root: string; outcome: "mismatch"; reason: string};

export interface BackfillReport {
  /** Echoes the caller's own `dryRun` choice - printed as a loud banner by the CLI script so a
   * report is never mistaken for "this already happened" when nothing was actually written. */
  dryRun: boolean;
  scanned: number;
  alreadyCovered: number;
  inserted: number;
  /** WP4.9V FIX ROUND 1 (D1) - see `BackfillOutcome`'s own `"reactivated"` doc comment. */
  reactivated: number;
  mismatches: BackfillMismatch[];
  /** One entry per scanned pet, in scan order - what `scripts/backfillTagArtifacts.ts` prints. */
  details: BackfillOutcome[];
}

export interface BackfillOptions {
  /**
   * Default `false`. When `true`, every read still happens (including `findActiveArtifactRoot`,
   * `findArtifactByRoot`, and `findBoundMintSessionByRoot`) but `store.createArtifact` (the only
   * write in this whole migration) is never called.
   *
   * WP4.9V FIX ROUND 1 (D2): verification runs via the exact same dispatch
   * (`verifyForProtocolVersion`, `lib/tags/artifact.ts`) `createTagArtifact` itself uses, AND every
   * PRECONDITION `createTagArtifact` itself checks before ever reaching that dispatch (a missing
   * `dogTag.cloneAddress`, a root already claimed by a different pet) is now also checked here,
   * identically, in BOTH modes, before either mode's own fork - so a dry-run prediction is exactly
   * what a real run would have decided, for the SAME reason, never a second, separately-maintained
   * approximation of that logic that can drift out of sync with it.
   */
  dryRun?: boolean;
}

export async function backfillTagArtifacts(store: BackfillStore, now: number, options: BackfillOptions = {}): Promise<BackfillReport> {
  const dryRun = options.dryRun ?? false;
  const pets = await store.listPetsWithRoot();
  const report: BackfillReport = {dryRun, scanned: 0, alreadyCovered: 0, inserted: 0, reactivated: 0, mismatches: [], details: []};

  for (const pet of pets) {
    report.scanned++;
    const normalizedRoot = pet.root.toLowerCase();

    const activeRoot = await store.findActiveArtifactRoot(pet.petId);
    if (activeRoot === normalizedRoot) {
      report.alreadyCovered++;
      report.details.push({petId: pet.petId, root: pet.root, outcome: "already_covered"});
      continue;
    }

    // WP4.9V FIX ROUND 1 (D2) - preconditions shared identically by BOTH dry-run and write, so a
    // dry run's prediction and a real run's outcome are actually identical for these two failure
    // modes, not just for the leaf-commitment dispatch. Checked in both modes, before either
    // mode's own fork below.
    if (!pet.cloneAddress) {
      const reason = "pet has no dogTag.cloneAddress on file - the artifact's issuerClone cannot be determined";
      report.mismatches.push({petId: pet.petId, root: pet.root, reason});
      report.details.push({petId: pet.petId, root: pet.root, outcome: "mismatch", reason});
      continue;
    }
    const existingArtifact = await store.findArtifactByRoot(normalizedRoot);
    if (existingArtifact && existingArtifact.petId !== pet.petId) {
      const reason = `this root is already recorded under a different pet (${existingArtifact.petId}) - refusing to also attach it to ${pet.petId}`;
      report.mismatches.push({petId: pet.petId, root: pet.root, reason});
      report.details.push({petId: pet.petId, root: pet.root, outcome: "mismatch", reason});
      continue;
    }

    const session = await store.findBoundMintSessionByRoot(pet.root);
    if (!session) {
      const reason = "no MintSession on file carries this pet's dogTag.root";
      report.mismatches.push({petId: pet.petId, root: pet.root, reason});
      report.details.push({petId: pet.petId, root: pet.root, outcome: "mismatch", reason});
      continue;
    }

    const leaves = Array.isArray(session.boundLeaves) ? (session.boundLeaves as OpenedLeaf[]) : [];
    const expectedIdentityLeaves = pet.external ? identityLeafSelfCheckSubset(leaves) : session.identityLeaves;
    const reservedLeafHashes = session.reservedLeafHashes ?? [];

    if (dryRun) {
      const verified = verifyForProtocolVersion({
        protocolVersion: session.protocolVersion,
        dogTagIdField: pet.dogTagIdField ?? session.dogTagIdField,
        root: pet.root,
        leaves,
        reservedLeafHashes,
        expectedIdentityLeaves,
        issuerClone: pet.cloneAddress,
      });
      if (!verified.ok) {
        const reason = `this session's stored root/leaves no longer recompute (${verified.reason})`;
        report.mismatches.push({petId: pet.petId, root: pet.root, reason});
        report.details.push({petId: pet.petId, root: pet.root, outcome: "mismatch", reason});
        continue;
      }
      // WP4.9V FIX ROUND 1 (D1) - the SAME existing-row read the precondition check above already
      // did tells us whether the write path would insert fresh or reactivate a stale inactive row,
      // without needing a second, separate lookup.
      if (existingArtifact && !existingArtifact.active) {
        report.reactivated++;
        report.details.push({petId: pet.petId, root: pet.root, outcome: "reactivated"});
      } else {
        report.inserted++;
        report.details.push({petId: pet.petId, root: pet.root, outcome: "inserted"});
      }
      continue;
    }

    let result: CreateTagArtifactResult;
    try {
      result = await store.createArtifact({
        petId: pet.petId,
        dogTagIdDec: pet.dogTagIdDec ?? session.dogTagIdDec,
        dogTagIdField: pet.dogTagIdField ?? session.dogTagIdField,
        root: pet.root,
        protocolVersion: session.protocolVersion,
        // WP4.10V item 2: the ONE record type this app has ever custodied, issued_here or
        // imported alike (see schemaIds.ts's own doc comment) - a backfilled row gets the same
        // stamp a fresh custodial-bind/booking-tier-4 write gets today, never left unset just
        // because its MintSession predates schemaId stamping.
        schemaId: DOG_PROFILE_SCHEMA_ID,
        leaves,
        reservedLeafHashes,
        expectedIdentityLeaves,
        source: pet.external ? "imported" : "issued_here",
        issuerClone: pet.cloneAddress,
        now,
      });
    } catch (err) {
      const reason = `createArtifact threw: ${err instanceof Error ? err.message : String(err)}`;
      report.mismatches.push({petId: pet.petId, root: pet.root, reason});
      report.details.push({petId: pet.petId, root: pet.root, outcome: "mismatch", reason});
      continue;
    }

    if (!result.ok) {
      const reason = `this session's stored root/leaves no longer recompute (${result.reason})`;
      report.mismatches.push({petId: pet.petId, root: pet.root, reason});
      report.details.push({petId: pet.petId, root: pet.root, outcome: "mismatch", reason});
      continue;
    }

    if (result.reactivated) {
      report.reactivated++;
      report.details.push({petId: pet.petId, root: pet.root, outcome: "reactivated"});
    } else {
      report.inserted++;
      report.details.push({petId: pet.petId, root: pet.root, outcome: "inserted"});
    }
  }

  return report;
}

/**
 * The schemaId repair path (WP4.10V item 2, closing the finding logged in ORCHESTRATION.md: a
 * live artifact backfilled before this stamping existed has `schemaId` genuinely unset, and the
 * export ceremony was serving `schemaId: null`). Separate from `backfillTagArtifacts` above - that
 * migration's job is "give a pet its first TagArtifact row"; this one's job is "an EXISTING row,
 * however it got here, is missing a field a later wave started stamping at write time." Every row
 * this app has ever custodied structurally corresponds to the same one record type (`schemaIds.ts`'s
 * own doc comment), so the repair is unconditional: any row with no `schemaId` at all gets the same
 * `DOG_PROFILE_SCHEMA_ID` value a fresh custodial-bind/booking-tier-4/backfill write already gets.
 *
 * IDEMPOTENT by construction: `store.listArtifactsMissingSchemaId` only ever returns rows where the
 * field is genuinely absent, so a second run finds nothing left to do. The mongo adapter's own write
 * additionally re-checks "still unset" at write time (never a blind `$set`), so this is also safe to
 * run concurrently with itself or with an ordinary write that happens to land on the same row
 * between the read and the write - whichever happens first wins, and the loser's `stampSchemaId`
 * call reports `applied: false` rather than silently overwriting a value someone else just set.
 *
 * CRITICAL: per this repo's own live-DB rule (this file's own header), this repair is tested only
 * against a disposable ephemeral mongod (`tests/unit/models/backfill.integration.test.ts`) - running
 * it against a live deployment is a deliberate operator step, never one this repo's builder/fixer
 * session executes.
 */
export interface SchemaIdRepairRow {
  artifactId: string;
  petId: string;
  root: string;
}

export interface SchemaIdRepairStore {
  /** Every row whose `schemaId` is genuinely absent - never one that merely holds a DIFFERENT
   * value, which this repair leaves untouched rather than overwriting. */
  listArtifactsMissingSchemaId(): Promise<SchemaIdRepairRow[]>;
  /** `true` if this call actually set `schemaId` (it was still unset at write time); `false` if a
   * concurrent write already gave the row a value in the interim - see this section's own doc
   * comment on why that is never overwritten. */
  stampSchemaId(artifactId: string, schemaId: string): Promise<boolean>;
}

export interface SchemaIdRepairReport {
  dryRun: boolean;
  scanned: number;
  stamped: number;
  /** A read-then-write race only (see `stampSchemaId`'s own doc comment) - the read already filters
   * to rows missing `schemaId`, so this is 0 in the overwhelmingly common single-writer case. */
  raced: number;
  details: (SchemaIdRepairRow & {outcome: "stamped" | "would_stamp" | "raced"})[];
}

export async function repairMissingSchemaIds(
  store: SchemaIdRepairStore,
  schemaId: string,
  options: BackfillOptions = {},
): Promise<SchemaIdRepairReport> {
  const dryRun = options.dryRun ?? false;
  const rows = await store.listArtifactsMissingSchemaId();
  const report: SchemaIdRepairReport = {dryRun, scanned: 0, stamped: 0, raced: 0, details: []};

  for (const row of rows) {
    report.scanned++;
    if (dryRun) {
      report.stamped++;
      report.details.push({...row, outcome: "would_stamp"});
      continue;
    }
    const applied = await store.stampSchemaId(row.artifactId, schemaId);
    if (applied) {
      report.stamped++;
      report.details.push({...row, outcome: "stamped"});
    } else {
      report.raced++;
      report.details.push({...row, outcome: "raced"});
    }
  }

  return report;
}
