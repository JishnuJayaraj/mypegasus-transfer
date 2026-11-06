import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RelativeDate, relativeDate } from "./relative-date";
import { renderUi } from "./test-utils";

describe("relativeDate", () => {
  it("counts calendar days from the given today", () => {
    expect(relativeDate("2026-11-09", "2026-11-06", "deadline")).toEqual({
      key: "relativeDate.inDays",
      count: 3,
    });
    expect(relativeDate("2026-11-06", "2026-11-06", "deadline").key).toBe("relativeDate.dueToday");
    expect(relativeDate("2026-11-06", "2026-11-06", "event").key).toBe("relativeDate.today");
    expect(relativeDate("2026-11-04", "2026-11-06", "deadline")).toEqual({
      key: "relativeDate.overdue",
      count: 2,
    });
    expect(relativeDate("2026-11-04", "2026-11-06", "event").key).toBe("relativeDate.daysAgo");
  });
});

describe("RelativeDate", () => {
  it("always shows the absolute TT.MM.JJJJ date beside the relative text", () => {
    renderUi(<RelativeDate date="2026-11-03" today="2026-11-06" kind="deadline" />);
    expect(screen.getByText(/seit 3 Tagen überfällig/)).toHaveTextContent(
      "seit 3 Tagen überfällig · 03.11.2026",
    );
    expect(screen.getByText("03.11.2026")).toHaveAttribute("datetime", "2026-11-03");
  });

  it("uses the singular for one day", () => {
    renderUi(<RelativeDate date="2026-11-07" today="2026-11-06" />);
    expect(screen.getByText(/in 1 Tag ·/)).toBeInTheDocument();
  });
});
