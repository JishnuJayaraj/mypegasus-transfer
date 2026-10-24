import { describe, expect, it } from "vitest";
import { orderEducation, orderSessions, recentWork } from "./rows";

describe("row order (ba-forms.md, row limits)", () => {
  it("orders sessions by date, then start", () => {
    const rows = [
      { date: "2091-03-02", from: "13:00", to: "14:00" },
      { date: "2091-02-20", from: "09:00", to: "10:00" },
      { date: "2091-03-02", from: "08:00", to: "09:00" },
      { date: "2091-03-02", from: "13:00", to: "15:00" },
    ];
    expect(orderSessions(rows).map((row) => `${row.date} ${row.from}-${row.to}`)).toEqual([
      "2091-02-20 09:00-10:00",
      "2091-03-02 08:00-09:00",
      "2091-03-02 13:00-14:00",
      "2091-03-02 13:00-15:00",
    ]);
  });

  it("puts the school qualification first, then the rest most recent first", () => {
    const rows = [
      { id: "a", from: "2070-01-01", to: "2072-01-01" },
      { id: "school", from: "2060-01-01", to: "2069-01-01", kind: "school" as const },
      { id: "running", from: "2080-01-01", to: null },
      { id: "b", from: "2073-01-01", to: "2075-01-01", kind: "other" as const },
      { id: "c", from: "2074-01-01", to: "2075-01-01" },
      { id: "running2", from: "2081-01-01", to: null },
    ];
    expect(orderEducation(rows).map((row) => row.id)).toEqual([
      "school",
      "running2",
      "running",
      "c",
      "b",
      "a",
    ]);
  });

  it("keeps the work of the last three years, most recent first", () => {
    const rows = [
      { id: "ended-before", from: "2080-01-01", to: "2088-02-28" },
      { id: "ended-on-boundary", from: "2080-01-01", to: "2088-03-01" },
      { id: "running", from: "2090-01-01", to: null },
      { id: "recent", from: "2089-01-01", to: "2089-12-31" },
    ];
    expect(recentWork(rows, "2091-03-01").map((row) => row.id)).toEqual([
      "running",
      "recent",
      "ended-on-boundary",
    ]);
  });
});
