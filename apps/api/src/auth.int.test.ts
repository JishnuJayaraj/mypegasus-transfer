import { seedStaffUserIds } from "@transfer/db";
import { resetTestDatabase } from "@transfer/db/testing";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { StaffUser } from "@transfer/domain";
import { z } from "zod";
import { expectProblem, jsonRequest, login, origin, readJson, testApp } from "./testing";

const { app, db } = testApp();

beforeEach(() => resetTestDatabase({ seed: true }));
afterAll(() => db.$client.end());

describe("dev session stub", () => {
  it.each(["/api/v1/projects", "/api/v1/me"])("requires a session for %s", async (path) => {
    await expectProblem(await app.request(path), 401, "unauthenticated");
  });

  it("rejects a tampered cookie", async () => {
    const { Cookie } = await login(app, seedStaffUserIds.admin);
    const tampered = Cookie.replace(seedStaffUserIds.admin, seedStaffUserIds.consultant);
    const res = await app.request("/api/v1/me", { headers: { Cookie: tampered } });
    await expectProblem(res, 401, "unauthenticated");
  });

  it("sets an httpOnly SameSite=Lax cookie and /me follows the active user", async () => {
    const res = await app.request(
      "/api/v1/dev/session",
      jsonRequest("POST", { staffUserId: seedStaffUserIds.admin }),
    );
    expect(res.headers.get("set-cookie")).toMatch(/^tp_staff_session=.*HttpOnly.*SameSite=Lax/);

    for (const [id, role] of [
      [seedStaffUserIds.admin, "admin"],
      [seedStaffUserIds.backOffice, "back_office"],
    ] as const) {
      const me = await app.request("/api/v1/me", { headers: await login(app, id) });
      expect(await readJson(me, StaffUser)).toMatchObject({ id, role });
    }
  });

  it("logs out with DELETE", async () => {
    const res = await app.request("/api/v1/dev/session", {
      method: "DELETE",
      headers: { ...(await login(app, seedStaffUserIds.admin)), Origin: origin },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toMatch(/^tp_staff_session=;.*Max-Age=0/);
  });

  it("lists the synthetic staff users for the switcher", async () => {
    const res = await app.request("/api/v1/dev/staff-users");
    expect(await readJson(res, z.array(StaffUser))).toHaveLength(5);
  });

  it("gives a 404 problem for an unknown staff user", async () => {
    const res = await app.request(
      "/api/v1/dev/session",
      jsonRequest("POST", { staffUserId: "00000000-0000-4000-a000-000000000000" }),
    );
    await expectProblem(res, 404, "not-found");
  });

  it("does not mount the dev routes unless AUTH_MODE is dev", async () => {
    const { app: oidcApp } = testApp({ env: { authMode: "oidc" }, db });
    await expectProblem(await oidcApp.request("/api/v1/dev/staff-users"), 404, "not-found");
  });
});

describe("mutations", () => {
  it("rejects a cross-origin form POST with a 403 problem", async () => {
    const res = await app.request("/api/v1/projects", {
      method: "POST",
      body: "name=x",
      headers: {
        ...(await login(app, seedStaffUserIds.admin)),
        Origin: "https://evil.example",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    await expectProblem(res, 403, "forbidden");
  });

  it("rejects a POST without a JSON body with a 415 problem", async () => {
    const res = await app.request("/api/v1/projects", {
      method: "POST",
      headers: { ...(await login(app, seedStaffUserIds.admin)), Origin: origin },
    });
    await expectProblem(res, 415, "unsupported-media-type");
  });
});
