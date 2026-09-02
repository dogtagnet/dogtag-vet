/**
 * WP4.9 checklist item 3c - the idempotent TagArtifact backfill migration (plans/
 * wp4.9-tag-data-custody.md section 2.1): for every pet with `dogTag.root`, find the bound
 * MintSession carrying that root, verify it (the exact same `verifyLeafCommitment` dispatch
 * `createTagArtifact` uses at every live write path), and insert the missing custody record.
 * REPORTS (never auto-fixes) any session whose stored data no longer recomputes.
 *
 * CRITICAL: this script is written and tested against SCRATCHPAD/ephemeral databases only - see
 * tests/unit/models/backfill.integration.test.ts (a real, disposable ephemeral mongod) and
 * docs/DEPLOY.md's "TagArtifact backfill" runbook. Running it against a live deployment's database
 * is a deliberate, documented operator step (docs/DEPLOY.md), never something this repo's own
 * builder/fixer session executes - see plans/orchestration/wp4.9V-progress.md's own header.
 *
 * Usage (MONGODB_URI required, exactly like `pnpm seed`):
 *   tsx scripts/backfillTagArtifacts.ts --dry-run   # report only - zero writes. Run this FIRST.
 *   tsx scripts/backfillTagArtifacts.ts --write     # actually inserts the missing TagArtifact rows.
 *
 * Refuses to run with neither flag (or both) rather than guessing a default in either direction -
 * every invocation states its own intent explicitly. Prints the target host/port/database name
 * (credentials redacted) before doing anything, so whoever runs this can visually confirm which
 * deployment it is about to touch.
 */
import "dotenv/config";
import {connectToDatabase} from "@/lib/db";
import {requireEnv} from "@/lib/env";
import {backfillTagArtifacts} from "@/lib/tags/backfill";
import {mongoBackfillStore} from "@/lib/tags/backfillMongoAdapter";

function redactedTarget(uri: string): string {
  try {
    const url = new URL(uri);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "(unparseable MONGODB_URI - refusing to print it in case it embeds credentials)";
  }
}

async function main(): Promise<void> {
  const dryRunFlag = process.argv.includes("--dry-run");
  const writeFlag = process.argv.includes("--write");
  if (dryRunFlag === writeFlag) {
    console.error("Usage: tsx scripts/backfillTagArtifacts.ts --dry-run | --write");
    console.error("Pass exactly one of --dry-run (report only) or --write (actually insert). Run --dry-run first.");
    process.exit(1);
  }

  const uri = requireEnv("MONGODB_URI");
  console.log(`Target database: ${redactedTarget(uri)}`);
  console.log(dryRunFlag ? "Mode: DRY RUN - no writes will be performed.\n" : "Mode: WRITE - missing TagArtifact rows will be inserted.\n");

  await connectToDatabase();

  const now = Math.floor(Date.now() / 1000);
  const report = await backfillTagArtifacts(mongoBackfillStore, now, {dryRun: dryRunFlag});

  for (const detail of report.details) {
    if (detail.outcome === "mismatch") {
      console.log(`MISMATCH  pet=${detail.petId} root=${detail.root} - ${detail.reason}`);
    } else if (detail.outcome === "inserted") {
      console.log(`${dryRunFlag ? "WOULD INSERT" : "INSERTED "} pet=${detail.petId} root=${detail.root}`);
    } else {
      console.log(`already covered  pet=${detail.petId} root=${detail.root}`);
    }
  }

  console.log(`\n${dryRunFlag ? "DRY RUN " : ""}Summary: ${report.scanned} pet(s) scanned, ${report.alreadyCovered} already covered, ` +
    `${report.inserted} ${dryRunFlag ? "would be inserted" : "inserted"}, ${report.mismatches.length} mismatch(es).`);

  if (report.mismatches.length > 0) {
    console.log("\nMismatches are NEVER auto-fixed. Each one above names the pet/root and the reason - investigate by hand before deciding what, if anything, to do about it.");
  }

  // Mongoose's open connection otherwise keeps the event loop alive forever - explicit exit, same
  // as scripts/seed.ts's own pattern. Exit code reflects whether any mismatch was found (1) or not
  // (0), NEVER whether writes happened - a clean --write run with mismatches still exits 1 so a
  // caller scripting this (cron, CI) notices without having to parse stdout.
  process.exit(report.mismatches.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
