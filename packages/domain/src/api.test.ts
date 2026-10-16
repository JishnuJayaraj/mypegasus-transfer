import { describe, expect, it } from "vitest";
import { PageQuery, ProblemDetails, Project, StaffUser, page } from "./index";

const project = {
  id: "00000000-0000-4000-9000-000000000001",
  name: "Restrukturierung Werk Nord",
  customerName: "Beispiel Maschinenbau GmbH",
  type: "ta_tg",
  status: "draft",
  projectAgenturKey: null,
  activatedAt: null,
  createdAt: "2026-10-15T20:05:23.123456Z",
  createdBy: "00000000-0000-4000-8000-000000000003",
};

describe("Project", () => {
  it("accepts a draft project and an active one with microsecond UTC timestamps", () => {
    expect(Project.parse(project)).toEqual(project);
    const active = {
      ...project,
      status: "active",
      projectAgenturKey: "beispielstadt-nord",
      activatedAt: "2026-10-16T08:00:00.000001Z",
    };
    expect(Project.parse(active)).toEqual(active);
  });

  it("rejects an unknown status and a timestamp with an offset", () => {
    expect(Project.safeParse({ ...project, status: "closed" }).success).toBe(false);
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
