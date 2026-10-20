import { createDb, seedRegionIds, seedStaffUserIds } from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { expectProblem, jsonRequest, login, readJson, testApp } from "./testing";

const { app, db, logs } = testApp();
// Wrong password: every query fails, like a database that is down.
const brokenUrl = new URL(testDatabaseUrls().app);
brokenUrl.password = "wrong";
const broken = testApp({ db: createDb(brokenUrl.toString()) });

beforeEach(() => resetTestDatabase({ seed: true }));
afterAll(() => Promise.all([db.$client.end(), broken.db.$client.end()]));

describe("health", () => {
  it("is public and reports the version", async () => {
    const res = await app.request("/api/v1/health");
    expect(await res.json()).toEqual({ status: "ok", version: "0.0.0" });
  });

  it("is ready when the database answers", async () => {
    expect((await app.request("/api/v1/health/ready")).status).toBe(200);
  });

  it("gives a 503 problem when the database is down", async () => {
    await expectProblem(
      await broken.app.request("/api/v1/health/ready"),
      503,
      "service-unavailable",
    );
  });
});

describe("errors", () => {
  it("gives a 404 problem for unknown /api paths", async () => {
    await expectProblem(await app.request("/api/v2/projects"), 404, "not-found");
    await expectProblem(await app.request("/api/v1/nope"), 404, "not-found");
  });

  it("gives a 500 problem without message or stack, with the request id of the log line", async () => {
    const auth = await login(app, seedStaffUserIds.admin);
    const res = await broken.app.request("/api/v1/me", { headers: auth });
    const body = await expectProblem(res, 500, "internal-error");
    const requestId = res.headers.get("x-request-id");
    expect(body).toEqual({
      type: "urn:transfer:problem:internal-error",
      title: "Internal server error",
      status: 500,
      instance: `urn:request:${requestId}`,
    });
    const lines = broken.logs.map((line) => JSON.parse(line));
    expect(lines.filter((l) => l.requestId === requestId).map((l) => l.status)).toContain(500);
    expect(broken.logs.join("\n")).not.toContain("password");
  });
});

describe("logging", () => {
  it("logs requests without bodies, query strings, cookies or headers", async () => {
    const auth = await login(app, seedStaffUserIds.projectLead);
    const name = "Zzyzx-Logtest-4711";
    await app.request(
      "/api/v1/projects",
      jsonRequest(
        "POST",
        { name, customerName: "Beispiel GmbH", type: "ta_only", regionId: seedRegionIds.nord },
        auth,
      ),
    );
    await app.request("/api/v1/projects?limit=7&cursor=Zzyzx", { headers: auth });

    const output = logs.join("\n");
    for (const forbidden of [name, "Zzyzx", "limit=7", auth.Cookie.split("=")[1]!, "Beispiel"]) {
      expect(output).not.toContain(forbidden);
    }
    const line = logs
      .map((l) => JSON.parse(l))
      .find((l) => l.method === "POST" && l.route === "/api/v1/projects");
    expect(line).toMatchObject({ status: 201, staffUserId: seedStaffUserIds.projectLead });
    expect(line).toHaveProperty("durationMs");
    expect(line).toHaveProperty("requestId");
  });
});

describe("OpenAPI document", () => {
  it("is OpenAPI 3.1 with every path under /api/v1", async () => {
    const OpenApiDoc = z.object({
      openapi: z.string(),
      paths: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.unknown()))),
    });
    const doc = await readJson(await app.request("/api/v1/openapi.json"), OpenApiDoc);
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).every((path) => path.startsWith("/api/v1/"))).toBe(true);
    expect(doc.paths["/api/v1/dev/session"]?.post?.["x-dev-only"]).toBe(true);
  });

  it("is not served in production", async () => {
    const prod = testApp({ env: { nodeEnv: "production", authMode: "oidc" }, db });
    expect((await prod.app.request("/api/v1/openapi.json")).status).toBe(404);
  });
});
