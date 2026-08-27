import {describe, expect, it} from "vitest";
import {findCoveringWindow, generateCandidateSlots, openWindowsForDate} from "@/lib/booking/windows";

describe("openWindowsForDate", () => {
  const rules = [{dayOfWeek: 4, startMinute: 540, endMinute: 1020, capacity: 1}];

  it("falls back to the matching weekly rule when no exception exists", () => {
    expect(openWindowsForDate("2026-01-15", rules, [])).toEqual([{startMinute: 540, endMinute: 1020, capacity: 1}]);
  });

  it("returns nothing for a closed exception", () => {
    expect(openWindowsForDate("2026-01-15", rules, [{date: "2026-01-15", closed: true}])).toEqual([]);
  });

  it("replaces the weekly rule entirely for a windows exception", () => {
    const windows = openWindowsForDate("2026-01-15", rules, [
      {date: "2026-01-15", closed: false, windows: [{startMinute: 600, endMinute: 660, capacity: 3}]},
    ]);
    expect(windows).toEqual([{startMinute: 600, endMinute: 660, capacity: 3}]);
  });
});

describe("generateCandidateSlots", () => {
  it("excludes a candidate whose buffered footprint would spill past the window", () => {
    const windows = [{startMinute: 0, endMinute: 60, capacity: 1}];
    // duration 30, buffer before 40 -> occupied start would be negative, never fits.
    const candidates = generateCandidateSlots(windows, 15, 30, 40, 0);
    expect(candidates).toHaveLength(0);
  });
});

describe("findCoveringWindow", () => {
  const windows = [
    {startMinute: 540, endMinute: 720, capacity: 1},
    {startMinute: 780, endMinute: 1020, capacity: 2},
  ];

  it("finds the window that fully contains the occupied interval", () => {
    expect(findCoveringWindow(windows, 800, 850)).toEqual({startMinute: 780, endMinute: 1020, capacity: 2});
  });

  it("returns null when no window covers the interval", () => {
    expect(findCoveringWindow(windows, 700, 800)).toBeNull(); // spans the gap between windows
  });

  it("returns null when the interval only partially overlaps a window", () => {
    expect(findCoveringWindow(windows, 700, 750)).toBeNull();
  });
});
