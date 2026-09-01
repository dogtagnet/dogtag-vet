import {describe, expect, it} from "vitest";
import {bucketKeysForInterval, scopedBucketKeys} from "@/lib/booking/buckets";

describe("bucketKeysForInterval", () => {
  it("returns a single bucket for an interval entirely inside one bucket", () => {
    expect(bucketKeysForInterval(10, 20, 300)).toEqual(["0"]);
  });

  it("returns every bucket an interval spans, in ascending order", () => {
    expect(bucketKeysForInterval(0, 1000, 300)).toEqual(["0", "1", "2", "3"]);
  });

  it("treats the end as exclusive - a boundary landing exactly on a bucket edge doesn't pull in the next bucket", () => {
    expect(bucketKeysForInterval(0, 300, 300)).toEqual(["0"]);
  });

  it("returns an empty array for a zero-length or inverted interval", () => {
    expect(bucketKeysForInterval(100, 100, 300)).toEqual([]);
    expect(bucketKeysForInterval(200, 100, 300)).toEqual([]);
  });
});

/** WP4.7 A4: the practitioner-mode counterpart. Back-compat is the headline property - absent or
 * empty scope must be BYTE-IDENTICAL to `bucketKeysForInterval` alone, which is what gives clinic
 * mode its untouched bucket behavior. */
describe("scopedBucketKeys", () => {
  it("back-compat: an undefined scope returns exactly the plain clinic-mode keys", () => {
    expect(scopedBucketKeys(0, 1000, undefined, 300)).toEqual(bucketKeysForInterval(0, 1000, 300));
  });

  it("back-compat: an empty scope also returns exactly the plain clinic-mode keys", () => {
    expect(scopedBucketKeys(0, 1000, [], 300)).toEqual(bucketKeysForInterval(0, 1000, 300));
  });

  it("a single-staffId scope prefixes every plain key with p:<staffId>:", () => {
    expect(scopedBucketKeys(0, 1000, ["vet-a"], 300)).toEqual(["p:vet-a:0", "p:vet-a:1", "p:vet-a:2", "p:vet-a:3"]);
  });

  it("a multi-staffId scope produces one full set of prefixed keys PER staffId, sorted by staffId then bucket number", () => {
    expect(scopedBucketKeys(0, 300, ["vet-b", "vet-a"], 300)).toEqual(["p:vet-a:0", "p:vet-b:0"]);
  });

  it("deduplicates a scope containing the same staffId more than once", () => {
    expect(scopedBucketKeys(0, 300, ["vet-a", "vet-a"], 300)).toEqual(["p:vet-a:0"]);
  });

  it("staffId ordering is deterministic and independent of input order (no-livelock property)", () => {
    const forward = scopedBucketKeys(0, 300, ["vet-a", "vet-b", "vet-c"], 300);
    const shuffled = scopedBucketKeys(0, 300, ["vet-c", "vet-a", "vet-b"], 300);
    expect(shuffled).toEqual(forward);
  });

  it("within one staffId, bucket numbers stay in the same relative ascending order as the plain keys", () => {
    const keys = scopedBucketKeys(0, 1000, ["vet-a"], 300);
    const bucketNumbers = keys.map((k) => Number(k.split(":")[2]));
    expect(bucketNumbers).toEqual([0, 1, 2, 3]);
  });
});
