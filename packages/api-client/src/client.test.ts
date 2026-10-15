import { testApp } from "@transfer/api/testing";
import { afterAll, describe, expect, it } from "vitest";
import { ApiProblemError, createApiClient } from "./index";

// The real app behind the client's fetch. These calls never reach the database.
const { app, db } = testApp();
const client = createApiClient({
  baseUrl: "http://localhost",
  fetch: (input, init) => Promise.resolve(app.fetch(new Request(input, init))),
});

afterAll(() => db.$client.end());

describe("createApiClient", () => {
  it("returns typed data", async () => {
    const { data } = await client.GET("/api/v1/health");
    expect(data).toEqual({ status: "ok", version: "0.0.0" });
  });

  it("turns problem+json into an ApiProblemError", async () => {
    const error = await client.GET("/api/v1/me").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiProblemError);
    expect((error as ApiProblemError).problem).toMatchObject({
      type: "urn:transfer:problem:unauthenticated",
      status: 401,
    });
    expect((error as ApiProblemError).status).toBe(401);
  });
});
