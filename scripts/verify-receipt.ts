/**
 * Offline re-verification of a downloaded wallet-registration receipt -
 * plans/wp4.2-client-wallet-registration.md: "a standalone `scripts/verify-receipt.ts` that
 * re-verifies a receipt JSON offline". No network or database access anywhere in this script:
 * everything it needs is either in the receipt file itself or in this repo's own installed viem.
 * See docs/client-wallet-registration.md's "Verifying a receipt" section for the full trust model
 * this is checking.
 *
 * Usage:
 *   pnpm verify-receipt <path-to-receipt.json>
 *   tsx scripts/verify-receipt.ts <path-to-receipt.json>
 *
 * Exits 0 and prints VALID only if BOTH checks pass: the signature recovers to the receipt's own
 * `address` (and to the signed message's own `wallet` field), AND the recomputed `receiptHash`
 * matches the one stored in the file. Exits 1 on any parse failure, signature mismatch, or hash
 * mismatch - never a bare crash on a malformed or hand-edited file.
 */
import {readFileSync} from "node:fs";
import {verifyReceiptExport} from "@/lib/registration/receipt";

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: verify-receipt <path-to-receipt.json>");
    process.exitCode = 1;
    return;
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    console.error(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const result = await verifyReceiptExport(parsed);
  if (!result.ok) {
    console.error(`INVALID: ${result.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Recovered signer:    ${result.recoveredSigner}`);
  console.log(`Address matches:     ${result.addressMatches ? "yes" : "NO - MISMATCH"}`);
  console.log(`Recomputed receiptHash: ${result.computedReceiptHash}`);
  console.log(`Stored receiptHash matches: ${result.receiptHashMatches ? "yes" : "NO - MISMATCH"}`);

  if (result.addressMatches && result.receiptHashMatches) {
    console.log("\nVALID: this receipt is a genuine, self-consistent DogTag wallet registration.");
  } else {
    console.error("\nINVALID: the recovered signature or receiptHash does not match this file's own claims. Do not trust this receipt.");
    process.exitCode = 1;
  }
}

main();
