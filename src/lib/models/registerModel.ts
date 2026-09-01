import mongoose, {type Model, type Schema, type SchemaType} from "mongoose";

/**
 * A stable fingerprint over `schema`'s own paths (sorted, so key ORDER never matters) plus the
 * "relevant options" that change a path's actual behavior - its mongoose `instance` (type),
 * required-ness, `unique`, and (sorted) `enum` values. Deliberately excludes anything that would
 * make two independently-built-but-equivalent schemas fingerprint differently, most importantly a
 * `default` VALUE (only whether one is present) - `default: () => randomUUID()` closures are
 * freshly allocated every time a model file re-evaluates, and comparing function identity or
 * `.toString()` text would make this fingerprint spuriously unstable across two calls that pass in
 * the exact same schema shape (`registerModel.test.ts`'s "SAME model instance ... separately-built
 * schema" case).
 *
 * Recurses into a nested schema (a single embedded subdocument - e.g. `Pet.dogTag` - or a
 * subdocument ARRAY - e.g. `Client.wallets[]`) via `SchemaType.schema`, so a field added ONLY
 * inside a nested schema (WP4.3/4.4's `dogTag.external`, `wallets[].via`/`bookingId` - neither of
 * which touches the OUTER schema's own top-level path list at all) still changes the fingerprint.
 * `seen` guards against an unbounded recursion if a schema is ever nested inside itself.
 */
function pathFingerprint(path: SchemaType, seen: ReadonlySet<Schema<unknown>>): string {
  const options = (path.options ?? {}) as {unique?: unknown; enum?: readonly unknown[]};
  const enumValues = Array.isArray(options.enum) ? [...options.enum].map(String).sort().join(",") : "";
  const nestedSchema = (path as unknown as {schema?: Schema<unknown>}).schema;
  const nested = nestedSchema ? `{${schemaFingerprint(nestedSchema, seen)}}` : "";
  return [path.instance, path.isRequired ? "req" : "opt", options.unique ? "uniq" : "", enumValues, nested].join(":");
}

function schemaFingerprint(schema: Schema<unknown>, seen: ReadonlySet<Schema<unknown>> = new Set()): string {
  if (seen.has(schema)) return "(cycle)";
  const nextSeen = new Set(seen).add(schema);
  // `mongoose.model(name, schema)` mutates `schema` at COMPILE time to add the version-key path
  // (`__v` by default, `schema.options.versionKey`) - added only then, never at `new Schema(...)`
  // construction time. `existing.schema` below has always already been compiled (it came from a
  // prior `mongoose.model()` call); a freshly-built incoming `schema` on this call has not been.
  // Without excluding it, that asymmetry would make EVERY equivalent-schema comparison look like
  // drift (the "SAME model instance" stability test), not just a genuine one - `__v` says nothing
  // about the shape either schema actually defines.
  const schemaOptions = (schema as unknown as {options?: {versionKey?: unknown}}).options;
  const versionKey = typeof schemaOptions?.versionKey === "string" ? schemaOptions.versionKey : undefined;
  return Object.keys(schema.paths)
    .filter((key) => key !== versionKey)
    .sort()
    .map((key) => `${key}=${pathFingerprint(schema.paths[key]!, nextSeen)}`)
    .join("|");
}

/**
 * Hot-reload-safe model registration: `mongoose.models.X ?? mongoose.model<T>("X", schema)` is the
 * idiomatic guard against Next.js dev-server module reloads re-registering a schema, but
 * `mongoose.models` is typed as `Record<string, Model<any>>` while `mongoose.model<T>(...)`
 * returns `Model<T>` - the resulting `??` union has two structurally different overload sets, and
 * TypeScript's strict mode refuses to call any method (`findById`, `create`, ...) on that union
 * ("has signatures, but none of those signatures are compatible with each other"). Centralizing
 * the cast here means every model file gets a single, precisely-typed `Model<T>` back instead of
 * repeating an `as Model<T>` at each call site.
 *
 * WP4.5 track3-sig fix 1: that idiomatic guard is also exactly what let a long-lived dev process
 * keep serving a `Client` model registered BEFORE WP4.2's `wallets[]` field existed forever, since
 * `mongoose.models.X` truthy short-circuits before the schema the CURRENT code just built is ever
 * consulted - the cached model's own strict-mode update-path casting then silently dropped a
 * `$push` to a path its schema had never heard of (this repo's forensic incident). Comparing the
 * cached model's own schema fingerprint against the incoming one closes that off structurally, for
 * every model, rather than requiring every call site to remember to restart the process: on a
 * mismatch, `mongoose.deleteModel` clears the stale registration and a fresh `mongoose.model` call
 * takes its place, bound to the schema the running code actually has right now. A cache hit (the
 * overwhelmingly common case, including every request in a normal warm process) costs one
 * fingerprint computation - cheap, and harmless in prod, where a model is registered exactly once
 * per process lifetime anyway.
 */
export function getOrCreateModel<T>(name: string, schema: Schema<T>): Model<T> {
  const existing = mongoose.models[name] as Model<T> | undefined;
  if (existing) {
    if (schemaFingerprint(existing.schema as Schema<unknown>) === schemaFingerprint(schema as Schema<unknown>)) {
      return existing;
    }
    mongoose.deleteModel(name);
  }
  return mongoose.model<T>(name, schema);
}
