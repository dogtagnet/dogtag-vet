import {readFileSync, readdirSync} from "node:fs";
import {resolve} from "node:path";
import {describe, expect, it} from "vitest";

/**
 * WP4.17 phase B fix round 1, D2 (wp4.17B-grade.md): the hand-authored EIP-712/booking-hash
 * vector files under tests/unit/vectors/ (see that directory's own README.md for why they are
 * not vendored from dogtag-protocol) must be named, with their location, in
 * docs/RELEASE-NOTES.md - being described in passing in this directory's README and the
 * top-level README's "Protocol sync" section was not enough for the phase B grade.
 *
 * `vectorFileNames` comes from an actual `readdirSync` of the vectors directory, not a
 * hand-typed list that could itself drift, so a future vector file added there and forgotten
 * in the release notes fails this suite by name for that exact file.
 *
 * WP4.18 fix round 1: Kenneth decided (2026-09-21) these files stay repo-local rather than
 * being promoted to dogtag-protocol - the release notes' old "ownership pending" wording is
 * stale now that the decision is made, so the wording check below moved with it.
 */
const vectorsDir = resolve(__dirname, "./vectors");
const vectorFileNames = readdirSync(vectorsDir)
  .filter((name) => name.endsWith(".json"))
  .sort();

const releaseNotes = readFileSync(resolve(__dirname, "../../docs/RELEASE-NOTES.md"), "utf8");

describe("docs/RELEASE-NOTES.md names every hand-authored vector file with its location", () => {
  it("found at least one vector file to check (guards against an empty or moved directory silently passing)", () => {
    expect(vectorFileNames.length).toBeGreaterThan(0);
  });

  it.each(vectorFileNames)("names tests/unit/vectors/%s", (name) => {
    expect(releaseNotes).toContain(`tests/unit/vectors/${name}`);
  });

  it("states their protocol ownership is repo-local by decision, with who and when (WP4.18 fix round 1)", () => {
    expect(releaseNotes).toContain("repo-local by decision (Kenneth, 2026-09-21)");
  });
});
