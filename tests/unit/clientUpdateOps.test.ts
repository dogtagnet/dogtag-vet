import {describe, expect, it} from "vitest";
import {splitSetUnsetOps} from "@/lib/models/Client";

/**
 * WP4.3 round-2 fix: PATCH /api/clients/:id used to build `{$set: {...parsed.data}}` with no
 * `$unset` branch at all, so a field a caller explicitly cleared (serialized as `null`, since JSON
 * has no way to send a literal `undefined`) was silently dropped by JSON.stringify before it ever
 * reached the schema, leaving the old value in the database while the response still reported
 * success. `splitSetUnsetOps` is the pure, DB-free half of the fix - it rules on the null-ness of
 * each value alone, not on which field it is, so it composes correctly whichever of
 * idDocType/idDocNumber (currently the only two client fields whose schema accepts `null` - see
 * updateClientSchema and its doc comment for why the rest do not, yet) a caller sends.
 */
describe("splitSetUnsetOps", () => {
  it("returns empty ops for an empty payload", () => {
    expect(splitSetUnsetOps({})).toEqual({setOps: {}, unsetOps: {}});
  });

  it("routes a defined, non-null value to setOps", () => {
    expect(splitSetUnsetOps({idDocType: "passport"})).toEqual({
      setOps: {idDocType: "passport"},
      unsetOps: {},
    });
  });

  it("routes a null value to unsetOps as the Mongo $unset sentinel, not to setOps", () => {
    expect(splitSetUnsetOps({idDocNumber: null})).toEqual({
      setOps: {},
      unsetOps: {idDocNumber: ""},
    });
  });

  it("omits an undefined value from both - undefined means untouched, not cleared", () => {
    expect(splitSetUnsetOps({idDocType: undefined})).toEqual({setOps: {}, unsetOps: {}});
  });

  it("splits a mixed payload: one field set, one cleared, one untouched", () => {
    const result = splitSetUnsetOps({idDocType: "national_id", idDocNumber: null, notes: undefined});
    expect(result).toEqual({
      setOps: {idDocType: "national_id"},
      unsetOps: {idDocNumber: ""},
    });
  });

  it("clears both fields independently in the same call", () => {
    expect(splitSetUnsetOps({idDocType: null, idDocNumber: null})).toEqual({
      setOps: {},
      unsetOps: {idDocType: "", idDocNumber: ""},
    });
  });

  it("does not special-case field names - any key's null clears, any key's defined value sets", () => {
    expect(splitSetUnsetOps({name: "Jane Doe", email: null})).toEqual({
      setOps: {name: "Jane Doe"},
      unsetOps: {email: ""},
    });
  });
});
