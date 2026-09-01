/**
 * Strips mongoose's own bookkeeping (`_id`, `__v`) from a `.lean()` result, recursively, so the
 * document can cross the React Server Component -> Client Component boundary. Next.js refuses any
 * prop with a `toJSON` method ("Only plain objects can be passed to Client Components...") and a
 * lean doc's `_id` is a bson `ObjectId` - exactly that. Every schema in this app keys its documents
 * by an application-level UUID (`petId`, `clientId`, ...) and marks subdocuments `{_id: false}`, so
 * nothing anywhere reads `_id`/`__v` - dropping them loses no information, and the declared
 * `XxxDoc` interfaces never included them in the first place (the runtime object finally matches
 * its type). `Date` values pass through untouched - the RSC wire format supports them natively.
 *
 * Use it at the page boundary, on the query result assignment, so every downstream prop is clean:
 * `const pet = toPlain(await Pet.findOne({petId}).lean<PetDoc>());`
 */
export function toPlain<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => toPlain(item)) as T;
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "_id" || key === "__v") continue;
      out[key] = toPlain(entry);
    }
    return out as T;
  }
  return value;
}
