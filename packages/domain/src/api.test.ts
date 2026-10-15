import { describe, expect, it } from "vitest";
import { PageQuery, ProblemDetails, Project, StaffUser, page } from "./index";

const project = {
  id: "00000000-0000-4000-9000-000000000001",
  name: "Restrukturierung Werk Nord",
  customerName: "Beispiel Maschinenbau GmbH",
  type: "ta_tg",
  signingDeadline: null,
  defaultTgStart: "2027-03-01",
  defaultTgEnd: null,
  createdAt: "2026-10-15T20:05:23.123456Z",
  createdBy: "00000000-0000-4000-8000-000000000003",
};

describe("Project", () => {
  it("accepts a project with nullable dates and a microsecond UTC timestamp", () => {
    expect(Project.parse(project)).toEqual(project);
  });

  it("rejects an impossible date and a timestamp with an offset", () => {
    expect(Project.safeParse({ ...project, defaultTgEnd: "2027-02-29" }).success).toBe(false);
    expect(Project.safeParse({ ...project, createdAt: "2026-10-15T22:05:23+02:00" }).success).toBe(
      false,
    );
  });
});

describe("StaffUser", () => {
  it("has id, display name and role", () => {
    const user = {
      id: project.createdBy,
      displayName: "Petra Projektleitung",
      role: "project_lead",
    };
    expect(StaffUser.parse(user)).toEqual(user);
  });
});

describe("PageQuery", () => {
  it("defaults the limit to 50 and leaves the cursor out", () => {
    expect(PageQuery.parse({})).toEqual({ limit: 50 });
  });

  it("coerces the limit from the query string", () => {
    expect(PageQuery.parse({ limit: "20", cursor: "abc" })).toEqual({ limit: 20, cursor: "abc" });
  });

  it.each(["0", "101", "1.5", "abc"])("rejects the limit %s", (limit) => {
    expect(PageQuery.safeParse({ limit }).success).toBe(false);
  });
});

describe("page", () => {
  it("has items and a nullable nextCursor", () => {
    const schema = page(StaffUser);
    expect(schema.parse({ items: [], nextCursor: null })).toEqual({ items: [], nextCursor: null });
    expect(schema.safeParse({ items: [] }).success).toBe(false);
  });
});

describe("ProblemDetails", () => {
  it("accepts an RFC 9457 problem with the errors extension", () => {
    const problem = {
      type: "urn:transfer:problem:validation-error",
      title: "Validation failed",
      status: 400,
      instance: "urn:request:7c1c",
      errors: [
        { pointer: "/name", code: "too_small", detail: "Too small" },
        { parameter: "cursor", code: "invalid_cursor", detail: "Malformed cursor" },
      ],
    };
    expect(ProblemDetails.parse(problem)).toEqual(problem);
  });
});
