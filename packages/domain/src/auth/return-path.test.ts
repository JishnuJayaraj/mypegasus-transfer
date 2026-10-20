import { describe, expect, it } from "vitest";
import { safeReturnPath } from "./return-path";

describe("safeReturnPath (D1, the login's return path)", () => {
  it.each([
    "/",
    "/projects",
    "/projects/",
    "/projects/new",
    "/projects/0a1b-2c/participations/x-1",
  ])("keeps the staff route %s", (path) => {
    expect(safeReturnPath(path)).toBe(path);
  });

  it.each([
    undefined,
    "",
    "projects",
    "//evil.example.org",
    "/\\evil.example.org",
    "https://evil.example.org/projects",
    "/api/v1/me",
    "/portal/",
    "/projects?x=1",
    "/projects#x",
    "/projects/../api",
    "/projects/%2e%2e",
    "/projectsx",
    `/projects/${"a".repeat(300)}`,
  ])("replaces %s with /", (path) => {
    expect(safeReturnPath(path)).toBe("/");
  });
});
