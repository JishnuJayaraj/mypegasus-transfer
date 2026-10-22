import { describe, expect, it } from "vitest";
import { matchesSearch, searchKey } from "./search";

// Synthetic names.
describe("searchKey", () => {
  it("folds case and diacritics, ß to ss, and collapses whitespace", () => {
    expect(searchKey("  Jürgen   GROẞE ")).toBe("jurgen grosse");
    expect(searchKey("Çelik Ölçer")).toBe("celik olcer");
    expect(searchKey("Straße")).toBe("strasse");
    expect(searchKey("")).toBe("");
  });
});

describe("matchesSearch", () => {
  const key = searchKey("P-0042 Größer Jürgen");

  it("matches when every word of the term occurs", () => {
    expect(matchesSearch(key, "jurgen")).toBe(true);
    expect(matchesSearch(key, "GROESSER")).toBe(false);
    expect(matchesSearch(key, "grosser jür")).toBe(true);
    expect(matchesSearch(key, "p-0042")).toBe(true);
    expect(matchesSearch(key, "jürgen anna")).toBe(false);
  });

  it("an empty term matches everything", () => {
    expect(matchesSearch(key, "  ")).toBe(true);
  });
});
