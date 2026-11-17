import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import yaml from "js-yaml";
import Ajv2020 from "ajv/dist/2020";

/**
 * Validates a value against a named schema of the VENDORED `protocol/specs/vet-public-api.yaml`
 * (never a hand copy). The schema is compiled as a `$ref` into the spec's own `components`, so
 * every in-document `#/components/schemas/...` reference resolves unchanged. `format` checks are off
 * (ajv-formats is not a dependency); everything structural - required, enum, pattern, anyOf,
 * uniqueItems, minItems - is enforced.
 */
const spec = yaml.load(readFileSync(resolve(__dirname, "../../../protocol/specs/vet-public-api.yaml"), "utf8")) as {
  components: unknown;
};
const ajv = new Ajv2020({strict: false, validateFormats: false, allErrors: true});

export function validateAgainstVetSpec(schemaName: string, value: unknown): {valid: boolean; errors: string} {
  const validate = ajv.compile({$ref: `#/components/schemas/${schemaName}`, components: spec.components});
  const valid = validate(value) as boolean;
  return {valid, errors: valid ? "" : ajv.errorsText(validate.errors)};
}
