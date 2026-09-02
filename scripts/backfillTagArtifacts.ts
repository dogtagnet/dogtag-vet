/**
 * WP4.9 checklist item 3c - the idempotent TagArtifact backfill migration (plans/
 * wp4.9-tag-data-custody.md section 2.1): for every pet with `dogTag.root`, find the bound
 * MintSession carrying that root, verify it (the exact same `verifyRedactedArtifact` dispatch
 * `createTagArtifact` uses at every live write path), and insert the missing custody record.
 * REPORTS (never auto-fixes) any session whose stored data no longer recomputes.
 *
 * WP4.10V item 2 added a SECOND, independent mode (`--repair-schema-id`): stamps `schemaId` on any
 * EXISTING `TagArtifact` row that has none at all (a row backfilled or otherwise written before
 * that stamping existed) - see `lib/tags/backfill.ts`'s `repairMissingSchemaIds` for the full
 * reasoning. Same `--dry-run`/`--write` selector, same script, because it is the identical
 * operator workflow (report first, then apply by hand) - just a different pass over the same
 * collection.
 *
 * CRITICAL: this script is written and tested against SCRATCHPAD/ephemeral databases only - see
 * tests/unit/models/backfill.integration.test.ts (a real, disposable ephemeral mongod). Running it
 * against a live deployment's database is a deliberate operator step taken by hand, after reading
 * its --dry-run report, never something this repo's own builder/fixer session executes - see
 * plans/orchestration/wp4.9V-progress.md's own header. (This backfill has already been run once,
 * for real, against the live UAT database - see plans/orchestration/ORCHESTRATION.md's status log
 * for that entry; a NEW deployment or a deployment that never issued/imported tags before adopting
 * this schema needs no action at all.)
 *
 * Usage (MONGODB_URI required, exactly like `pnpm seed`):
 *   tsx scripts/backfillTagArtifacts.ts --dry-run                        # report only - zero writes. Run this FIRST.
 *   tsx scripts/backfillTagArtifacts.ts --write                          # actually inserts the missing TagArtifact rows.
 *   tsx scripts/backfillTagArtifacts.ts --repair-schema-id --dry-run     # report which rows have no schemaId.
 *   tsx scripts/backfillTagArtifacts.ts --repair-schema-id --write       # actually stamps them.
 *
 * Refuses to run with neither of --dry-run/--write (or both) rather than guessing a default in
 * either direction - every invocation states its own intent explicitly. Prints the target
 * host/port/database name (credentials redacted) before doing anything, so whoever runs this can
 * visually confirm which deployment it is about to touch.
 */
import "dotenv/config";
import {connectToDatabase} from "@/lib/db";
import {requireEnv} from "@/lib/env";
import {backfillTagArtifacts, repairMissingSchemaIds} from "@/lib/tags/backfill";
import {mongoBackfillStore, mongoSchemaIdRepairStore} from "@/lib/tags/backfillMongoAdapter";
import {DOG_PROFILE_SCHEMA_ID} from "@/lib/tags/schemaIds";

function redactedTarget(uri: string): string {
  try {
    const url = new URL(uri);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "(unparseable MONGODB_URI - refusing to print it in case it embeds credentials)";
  }
}

async function runBackfill(dryRunFlag: boolean): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const report = await backfillTagArtifacts(mongoBackfillStore, now, {dryRun: dryRunFlag});

  for (const detail of report.details) {
    if (detail.outcome === "mismatch") {
      console.log(`MISMATCH  pet=${detail.petId} root=${detail.root} - ${detail.reason}`);
    } else if (detail.outcome === "inserted") {
      console.log(`${dryRunFlag ? "WOULD INSERT" : "INSERTED "} pet=${detail.petId} root=${detail.root}`);
    } else if (detail.outcome === "reactivated") {
      // WP4.9V FIX ROUND 1 (D1) - a row for this exact (pet, root) already existed but was
      // inactive (the crash-window repair state) - promoted back to active rather than inserted.
      console.log(`${dryRunFlag ? "WOULD REACTIVATE" : "REACTIVATED "} pet=${detail.petId} root=${detail.root}`);
    } else {
      console.log(`already covered  pet=${detail.petId} root=${detail.root}`);
    }
  }

  console.log(`\n${dryRunFlag ? "DRY RUN " : ""}Summary: ${report.scanned} pet(s) scanned, ${report.alreadyCovered} already covered, ` +
    `${report.inserted} ${dryRunFlag ? "would be inserted" : "inserted"}, ` +
    `${report.reactivated} ${dryRunFlag ? "would be reactivated" : "reactivated"}, ${report.mismatches.length} mismatch(es).`);

  if (report.mismatches.length > 0) {
    console.log("\nMismatches are NEVER auto-fixed. Each one above names the pet/root and the reason - investigate by hand before deciding what, if anything, to do about it.");
  }

  return report.mismatches.length > 0 ? 1 : 0;
}

/** WP4.10V item 2's second mode - see this script's own header and `lib/tags/backfill.ts`'s
 * `repairMissingSchemaIds` doc comment. Always stamps `DOG_PROFILE_SCHEMA_ID`, the one record type
 * this app has ever custodied (schemaIds.ts) - never a mismatch/report-and-skip case the way the
 * main backfill has, since there is nothing to verify here beyond "is schemaId already set". */
async function runSchemaIdRepair(dryRunFlag: boolean): Promise<number> {
  const report = await repairMissingSchemaIds(mongoSchemaIdRepairStore, DOG_PROFILE_SCHEMA_ID, {dryRun: dryRunFlag});

  for (const detail of report.details) {
    if (detail.outcome === "would_stamp") {
      console.log(`WOULD STAMP  pet=${detail.petId} root=${detail.root} artifactId=${detail.artifactId}`);
    } else if (detail.outcome === "stamped") {
      console.log(`STAMPED      pet=${detail.petId} root=${detail.root} artifactId=${detail.artifactId}`);
    } else {
      console.log(`RACED (already stamped by someone else)  pet=${detail.petId} root=${detail.root} artifactId=${detail.artifactId}`);
    }
  }

  console.log(`\n${dryRunFlag ? "DRY RUN " : ""}Summary: ${report.scanned} row(s) missing schemaId, ` +
    `${report.stamped} ${dryRunFlag ? "would be stamped" : "stamped"} with "${DOG_PROFILE_SCHEMA_ID}", ${report.raced} raced.`);

  return 0;
}

async function main(): Promise<void> {
  const dryRunFlag = process.argv.includes("--dry-run");
  const writeFlag = process.argv.includes("--write");
  const repairSchemaIdFlag = process.argv.includes("--repair-schema-id");
  if (dryRunFlag === writeFlag) {
    console.error("Usage: tsx scripts/backfillTagArtifacts.ts [--repair-schema-id] --dry-run | --write");
    console.error("Pass exactly one of --dry-run (report only) or --write (actually apply). Run --dry-run first.");
    process.exit(1);
  }

  const uri = requireEnv("MONGODB_URI");
  console.log(`Target database: ${redactedTarget(uri)}`);
  console.log(
    `Mode: ${repairSchemaIdFlag ? "REPAIR-SCHEMA-ID " : ""}${dryRunFlag ? "DRY RUN - no writes will be performed." : "WRITE - " + (repairSchemaIdFlag ? "missing schemaId values will be stamped." : "missing TagArtifact rows will be inserted.")}\n`,
  );

  await connectToDatabase();

  const exitCode = repairSchemaIdFlag ? await runSchemaIdRepair(dryRunFlag) : await runBackfill(dryRunFlag);

  // Mongoose's open connection otherwise keeps the event loop alive forever - explicit exit, same
  // as scripts/seed.ts's own pattern. Exit code reflects whether the backfill mode found a
  // mismatch (1) or not (0), NEVER whether writes happened - a clean --write run with mismatches
  // still exits 1 so a caller scripting this (cron, CI) notices without having to parse stdout.
  // The repair mode always exits 0 (it has no "mismatch" concept - see runSchemaIdRepair).
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
