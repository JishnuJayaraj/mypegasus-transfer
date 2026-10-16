import { describe, expect, it } from "vitest";
import { functionRefusal } from "./database-errors";

describe("functionRefusal", () => {
  it("reads the code of a P0001 refusal, wrapped by Drizzle or not", () => {
    const driver = { code: "P0001", message: "project_unchanged" };
    expect(functionRefusal(Object.assign(new Error("Failed query"), { cause: driver }))).toBe(
      "project_unchanged",
    );
    expect(functionRefusal(driver)).toBe("project_unchanged");
  });

  it("is undefined for every other error", () => {
    expect(functionRefusal(new Error("boom"))).toBeUndefined();
    expect(functionRefusal({ cause: { code: "23514", message: "check" } })).toBeUndefined();
    expect(functionRefusal({ cause: { code: "P0001", message: "" } })).toBeUndefined();
    expect(functionRefusal(null)).toBeUndefined();
    expect(functionRefusal(undefined)).toBeUndefined();
  });
});
