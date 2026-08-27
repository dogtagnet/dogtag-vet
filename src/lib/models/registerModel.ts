import mongoose, {type Model, type Schema} from "mongoose";

/**
 * Hot-reload-safe model registration: `mongoose.models.X ?? mongoose.model<T>("X", schema)` is the
 * idiomatic guard against Next.js dev-server module reloads re-registering a schema, but
 * `mongoose.models` is typed as `Record<string, Model<any>>` while `mongoose.model<T>(...)`
 * returns `Model<T>` - the resulting `??` union has two structurally different overload sets, and
 * TypeScript's strict mode refuses to call any method (`findById`, `create`, ...) on that union
 * ("has signatures, but none of those signatures are compatible with each other"). Centralizing
 * the cast here means every model file gets a single, precisely-typed `Model<T>` back instead of
 * repeating an `as Model<T>` at each call site.
 */
export function getOrCreateModel<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined) ?? mongoose.model<T>(name, schema);
}
