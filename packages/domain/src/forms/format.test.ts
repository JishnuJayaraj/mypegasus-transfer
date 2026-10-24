import { describe, expect, it } from "vitest";
import { formatFormDate, formatFormNumber, isFormDate, isFormTime, isPrintable } from "./format";

describe("form formats (ba-forms.md, validation before rendering)", () => {
  it("writes dates TT.MM.JJJJ and refuses an impossible one", () => {
    expect(formatFormDate("2024-02-29")).toBe("29.02.2024");
    expect(() => formatFormDate("2023-02-29")).toThrow(RangeError);
  });

  it("knows real TT.MM.JJJJ dates: the month-14 date is not one", () => {
    expect(isFormDate("29.02.2024")).toBe(true);
    expect(isFormDate("29.02.2023")).toBe(false);
    expect(isFormDate("03.14.1998")).toBe(false);
    expect(isFormDate("1998-03-14")).toBe(false);
  });

  it("knows hh:mm times from 00:00 to 23:59", () => {
    expect(["00:00", "09:30", "23:59"].map(isFormTime)).toEqual([true, true, true]);
    expect(["24:00", "9:30", "12:60", "12.30"].map(isFormTime)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("writes decimals with a comma", () => {
    expect(formatFormNumber(38.5)).toBe("38,5");
    expect(formatFormNumber(40)).toBe("40");
  });

  it("prints Latin with its extensions, never other scripts or controls", () => {
    expect(isPrintable("Łucja Ayşe Doğan-Großmann, Ștefan, Nguyễn – „x“ €", false)).toBe(true);
    expect(isPrintable("Иван", false)).toBe(false);
    expect(isPrintable("a\tb", false)).toBe(false);
    expect(isPrintable("a\nb", false)).toBe(false);
    expect(isPrintable("a\nb", true)).toBe(true);
  });
});
