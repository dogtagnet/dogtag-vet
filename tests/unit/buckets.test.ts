import {describe, expect, it} from "vitest";
import {bucketKeysForInterval} from "@/lib/booking/buckets";

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
