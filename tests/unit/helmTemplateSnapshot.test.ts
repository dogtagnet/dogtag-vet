import {describe, expect, it} from "vitest";
import {execFileSync} from "node:child_process";
import {resolve} from "node:path";

/**
 * WP4.17 B14 - snapshots `helm template`'s full output for the documented example values file
 * (`helm/dogtag-vet/values-example.yaml`) so an unintentional change to any chart template (a
 * probe silently dropped, an env var silently no longer wired to a container, a value that stops
 * reaching the rendered manifest) shows up as a failing test instead of only being noticed on a
 * real cluster - see that file's own header comment for the install command it documents.
 *
 * Guarded with a skip, not a hard failure, when `helm` is not on PATH: a clean clone without helm
 * installed should not fail `pnpm test` over a chart-only check - `docs/DEPLOY.md`'s "Verify the
 * chart with helm lint ... and helm template" step already covers a machine that does have it.
 *
 * Recorded against helm v4.2.4 (darwin/arm64). `helm template`'s exact output formatting is a CLI
 * detail, not a chart-schema guarantee - a materially different helm major version (this chart's
 * own docs also target the widely-installed v3 line) could in principle shift incidental
 * formatting with no change to the chart itself. Treat a failure here as "go look", not
 * automatically "the chart regressed" - diff against a fresh `helm template` run before assuming
 * which one is true.
 */

function helmAvailable(): boolean {
  try {
    execFileSync("helm", ["version", "--short"], {stdio: "ignore"});
    return true;
  } catch {
    return false;
  }
}

const chartDir = resolve(__dirname, "../../helm/dogtag-vet");
const valuesFile = resolve(chartDir, "values-example.yaml");

describe.skipIf(!helmAvailable())("helm template (dogtag-vet chart, documented example values)", () => {
  it("renders the documented example values file the same way", () => {
    const output = execFileSync("helm", ["template", "dogtag-vet", chartDir, "-f", valuesFile], {
      encoding: "utf8",
    });
    expect(output).toMatchSnapshot();
  });
});
