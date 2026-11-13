import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ProjectDashboard } from "@transfer/domain";
import { describe, expect, it } from "vitest";

// The overview's visual fixture answers the API with the API's own shapes (the dashboard's
// schema), so a fixture that drifts from the contract fails here, not in the pixel comparison.
describe("the project overview fixture", () => {
  it("holds a dashboard the API's schema accepts", () => {
    const fixture = JSON.parse(
      readFileSync(resolve("e2e/fixtures/project-overview.json"), "utf8"),
    ) as { projectId: string; responses: Record<string, unknown> };
    const key = `/api/v1/projects/${fixture.projectId}/dashboard`;
    expect(ProjectDashboard.safeParse(fixture.responses[key]).success).toBe(true);
  });
});
