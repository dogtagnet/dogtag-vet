import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {describe, expect, it} from "vitest";
import {KNOWN_RECORD_STANDARDS} from "@/lib/records/standards";

/**
 * Grade round 1 O1: `src/lib/records/standards.ts` is a hand-maintained mirror of
 * `protocol/specs/standards/index.yaml`'s own `standards[]` list - its own header already says so,
 * and WP4.10V's grade D5 raised exactly this class of defect for a different zod-vs-ajv registry
 * mirror in this same repo. At the time this test was written, the `id`/`version` pairs already
 * matched but the display `name` values had already silently drifted (this app never validates
 * `name`, only `id`+`version` - `isKnownRecordStandard`'s own body - so drift there is harmless
 * today but a live demonstration of the risk the id/version pair does NOT have, and must not gain).
 *
 * No `yaml`/`js-yaml` dependency exists anywhere in this app (`standards.ts`'s own doc comment) and
 * this test does not want to be the one place that adds one just to read three lines - a plain regex
 * over the file's own text extracts each `- id: ... \n    version: ...` pair, which is enough for
 * THIS file's own consistent shape (not a general YAML parser, and not trying to be one).
 */
describe("KNOWN_RECORD_STANDARDS vs protocol/specs/standards/index.yaml - id/version drift guard", () => {
  function idVersionPairsFromYaml(): {id: string; version: string}[] {
    const text = readFileSync(resolve(__dirname, "../../../protocol/specs/standards/index.yaml"), "utf8");
    const pairRe = /^\s*-\s*id:\s*(\S+)\s*\n\s*version:\s*"?([^"\n]+?)"?\s*$/gm;
    const pairs: {id: string; version: string}[] = [];
    let match: RegExpExecArray | null;
    while ((match = pairRe.exec(text))) {
      const [, id, version] = match;
      if (!id || !version) continue; // can't happen - both groups are non-optional in the pattern - but never a non-null assertion
      pairs.push({id, version});
    }
    return pairs;
  }

  it("the yaml registry is non-empty and this extraction actually finds entries (a guard against the regex itself silently matching nothing)", () => {
    expect(idVersionPairsFromYaml().length).toBeGreaterThan(0);
  });

  it("KNOWN_RECORD_STANDARDS' {id, version} set equals the yaml registry's {id, version} set exactly - same size, same members, neither a subset of the other", () => {
    const fromYaml = idVersionPairsFromYaml()
      .map((p) => `${p.id}@${p.version}`)
      .sort();
    const fromApp = KNOWN_RECORD_STANDARDS.map((s) => `${s.id}@${s.version}`).sort();
    expect(fromApp).toEqual(fromYaml);
  });
});
