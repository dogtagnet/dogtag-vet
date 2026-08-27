import {describe, expect, it} from "vitest";
import {countOverlapping, intervalsOverlap} from "@/lib/booking/occupied";

describe("intervalsOverlap", () => {
  it("detects a genuine overlap", () => {
    expect(intervalsOverlap(0, 10, 5, 15)).toBe(true);
  });

  it("does not count touching endpoints as overlapping", () => {
    expect(intervalsOverlap(0, 10, 10, 20)).toBe(false);
    expect(intervalsOverlap(10, 20, 0, 10)).toBe(false);
  });

  it("detects one interval fully containing another", () => {
    expect(intervalsOverlap(0, 100, 40, 50)).toBe(true);
  });

  it("does not overlap when fully separated", () => {
    expect(intervalsOverlap(0, 10, 20, 30)).toBe(false);
  });
});

describe("countOverlapping", () => {
  it("counts only the intervals that actually overlap", () => {
    const count = countOverlapping(
      {start: 100, end: 200},
      [
        {start: 0, end: 100}, // touches, not overlapping
        {start: 150, end: 250}, // overlaps
        {start: 190, end: 195}, // fully inside
        {start: 300, end: 400}, // separate
      ],
    );
    expect(count).toBe(2);
  });

  it("returns 0 against an empty set", () => {
    expect(countOverlapping({start: 0, end: 10}, [])).toBe(0);
  });
});
