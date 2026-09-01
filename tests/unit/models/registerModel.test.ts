import {afterEach, describe, expect, it} from "vitest";
import mongoose, {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";

/**
 * WP4.5 track3-sig, fix 1: the forensic incident (plans/wp4.5-track3sig-plan.md) was a long-lived
 * dev process whose cached `mongoose.models.Client` predated WP4.2's `wallets[]` field - mongoose's
 * default `mongoose.models[name] ?? mongoose.model(name, schema)` guard (the ORIGINAL
 * `getOrCreateModel`, before this fix) happily kept serving that stale model forever, because it
 * never compares the CACHED model's schema against the schema the CURRENT code just built. This
 * suite pins the fix: a stable fingerprint over the schema's own `paths` (recursing into nested/
 * array subdocument schemas) detects drift and re-registers, while two structurally-identical-but-
 * separately-built schemas must NOT cause spurious re-registration on every call.
 */

interface TestDocV1 {
  name: string;
}

interface TestDocV2 {
  name: string;
  extra: string;
}

function uniqueName(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2)}`;
}

afterEach(() => {
  // Belt-and-braces: every test below uses its own unique model name, but clean up anyway so a
  // failed assertion mid-test never leaks a registered model into a later test in this same file.
  for (const name of Object.keys(mongoose.models)) {
    if (name.startsWith("Repro_") || name.startsWith("Fp_")) mongoose.deleteModel(name);
  }
});

describe("getOrCreateModel (schema-drift-aware registration)", () => {
  it("returns the SAME model instance on a second call with an equivalent (but separately-built) schema", () => {
    const name = uniqueName("Fp_stable");
    const schemaA = new Schema<TestDocV1>({name: {type: String, required: true}});
    const modelA = getOrCreateModel<TestDocV1>(name, schemaA);

    // A genuinely independent Schema object - not the same reference as schemaA - built the exact
    // same way a hot-reloaded module would rebuild it from identical source. If the fingerprint is
    // unstable (e.g. depends on object insertion order, or on the Schema object's own identity),
    // this would be wrongly treated as drift and the model would be needlessly re-registered.
    const schemaB = new Schema<TestDocV1>({name: {type: String, required: true}});
    const modelB = getOrCreateModel<TestDocV1>(name, schemaB);

    expect(modelB).toBe(modelA);
    expect(mongoose.models[name]!.schema).toBe(schemaA);
  });

  it("re-registers when a top-level field is added (the WP4.2 wallets[] scenario)", () => {
    const name = uniqueName("Fp_addfield");
    const oldSchema = new Schema<TestDocV1>({name: {type: String, required: true}});
    const oldModel = getOrCreateModel<TestDocV1>(name, oldSchema);

    const newSchema = new Schema<TestDocV2>({
      name: {type: String, required: true},
      extra: {type: String, required: true},
    });
    const newModel = getOrCreateModel<TestDocV2>(name, newSchema);

    expect(newModel).not.toBe(oldModel);
    expect(mongoose.models[name]!.schema).toBe(newSchema);
  });

  it("re-registers when a field's required-ness changes (same field name, different constraint)", () => {
    const name = uniqueName("Fp_required");
    const optionalSchema = new Schema<TestDocV1>({name: {type: String}});
    const optionalModel = getOrCreateModel<TestDocV1>(name, optionalSchema);

    const requiredSchema = new Schema<TestDocV1>({name: {type: String, required: true}});
    const requiredModel = getOrCreateModel<TestDocV1>(name, requiredSchema);

    expect(requiredModel).not.toBe(optionalModel);
  });

  it("re-registers when an enum's allowed values change", () => {
    const name = uniqueName("Fp_enum");
    interface Doc {
      status: string;
    }
    const oldSchema = new Schema<Doc>({status: {type: String, enum: ["a", "b"]}});
    const oldModel = getOrCreateModel<Doc>(name, oldSchema);

    const newSchema = new Schema<Doc>({status: {type: String, enum: ["a", "b", "c"]}});
    const newModel = getOrCreateModel<Doc>(name, newSchema);

    expect(newModel).not.toBe(oldModel);
  });

  it("detects drift inside a NESTED single-subdocument schema (the Pet.dogTag.external scenario)", () => {
    const name = uniqueName("Fp_nested");
    interface Inner {
      root?: string;
    }
    interface InnerV2 {
      root?: string;
      external?: boolean;
    }
    interface Outer {
      dogTag: Inner;
    }
    interface OuterV2 {
      dogTag: InnerV2;
    }

    const innerV1 = new Schema<Inner>({root: String}, {_id: false});
    const outerV1 = new Schema<Outer>({dogTag: {type: innerV1, default: () => ({})}});
    const modelV1 = getOrCreateModel<Outer>(name, outerV1);

    // Same OUTER shape, but the nested schema gained a field - exactly WP4.4's `dogTag.external`
    // landing on `Pet` without a single top-level path changing.
    const innerV2 = new Schema<InnerV2>({root: String, external: Boolean}, {_id: false});
    const outerV2 = new Schema<OuterV2>({dogTag: {type: innerV2, default: () => ({})}});
    const modelV2 = getOrCreateModel<OuterV2>(name, outerV2);

    expect(modelV2).not.toBe(modelV1);
    expect(mongoose.models[name]!.schema).toBe(outerV2);
  });

  it("detects drift inside a subdocument ARRAY schema (the Client.wallets[].via scenario)", () => {
    const name = uniqueName("Fp_array");
    interface Item {
      address: string;
    }
    interface ItemV2 {
      address: string;
      via?: string;
    }
    interface Doc {
      wallets: Item[];
    }
    interface DocV2 {
      wallets: ItemV2[];
    }

    const itemV1 = new Schema<Item>({address: {type: String, required: true}}, {_id: false});
    const docV1Schema = new Schema<Doc>({wallets: {type: [itemV1], default: []}});
    const modelV1 = getOrCreateModel<Doc>(name, docV1Schema);

    const itemV2 = new Schema<ItemV2>({address: {type: String, required: true}, via: String}, {_id: false});
    const docV2Schema = new Schema<DocV2>({wallets: {type: [itemV2], default: []}});
    const modelV2 = getOrCreateModel<DocV2>(name, docV2Schema);

    expect(modelV2).not.toBe(modelV1);
    expect(mongoose.models[name]!.schema).toBe(docV2Schema);
  });

  it("does not re-register when called repeatedly with the identical schema object", () => {
    const name = uniqueName("Fp_sameref");
    const schema = new Schema<TestDocV1>({name: {type: String, required: true}});
    const first = getOrCreateModel<TestDocV1>(name, schema);
    const second = getOrCreateModel<TestDocV1>(name, schema);
    const third = getOrCreateModel<TestDocV1>(name, schema);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });
});
