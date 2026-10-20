import { ManualClock } from "@transfer/adapters";
import { createDb, seedStaffUserIds } from "@transfer/db";
import { resetTestDatabase, testDatabaseUrls } from "@transfer/db/testing";
import { CurrentStaffUser, StaffUser } from "@transfer/domain";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createOidc } from "./oidc";
import { createTestIssuer, testClient, testIssuer, type TestClaims } from "./oidc-test-issuer";
import { expectProblem, jsonRequest, login, origin, readJson, testApp } from "./testing";

// Slice 3 plan D1–D6 (PR 3b): staff sessions in the store for both login modes, OIDC against a
// local test issuer, CSRF, and the staff audit trail.
const owner = createDb(testDatabaseUrls().owner);
const { app, db } = testApp();
const pl = seedStaffUserIds.projectLead;
const consultant = seedStaffUserIds.consultant;
const COOKIE = "__Host-tp_staff";

const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0];
const hashOf = (cookie: string) => createHash("sha256").update(cookie.split("=")[1]!).digest("hex");

const sessionRow = async (cookie: string) =>
  (
    await owner.$client.query(
      `select staff_user_id, end_reason, expires_at = created_at + interval '8 hours' as eight_hours
       from staff_session where token_hash = $1`,
      [hashOf(cookie)],
    )
  ).rows[0];
const staffEvents = async () =>
  (
    await owner.$client.query(
      `select event_type, actor_staff_user_id, subject_staff_user_id, reason_code, details
       from staff_audit_event order by seq`,
    )
  ).rows;

/** A callback's result as the browser and the database see it. */
const outcome = async (res: Response) => ({
  status: res.status,
  location: res.headers.get("location"),
  session: cookieOf(res, COOKIE),
  identity: await identityOf(pl),
  events: await staffEvents(),
});

const identityOf = async (id: string) =>
  (
    await owner.$client.query("select oidc_issuer, oidc_subject from staff_user where id = $1", [
      id,
    ])
  ).rows[0];

beforeEach(() => resetTestDatabase({ seed: true, keepSessions: false }));
afterAll(() => Promise.all([db.$client.end(), owner.$client.end()]));

describe("sessions in the store (D1, D2)", () => {
  it.each(["/api/v1/projects", "/api/v1/me"])("requires a session for %s", async (path) => {
    await expectProblem(await app.request(path), 401, "unauthenticated");
  });

  it("sets a __Host- cookie whose token's SHA-256 is the session row, for 8 hours", async () => {
    const res = await app.request("/api/v1/dev/session", jsonRequest("POST", { staffUserId: pl }));
    expect(res.status).toBe(204);
    const header = res.headers.getSetCookie()[0]!;
    expect(header).toMatch(
      /^__Host-tp_staff=[A-Za-z0-9_-]{43}; Path=\/; Expires=[^;]+; HttpOnly; Secure; SameSite=Lax$/,
    );
    const cookie = cookieOf(res, COOKIE)!;
    expect(await sessionRow(cookie)).toEqual({
      staff_user_id: pl,
      end_reason: null,
      eight_hours: true,
    });
    const me = await readJson(
      await app.request("/api/v1/me", { headers: { Cookie: cookie } }),
      CurrentStaffUser,
    );
    expect(me).toMatchObject({ id: pl, role: "project_lead" });
    const hours = (Date.parse(me.sessionExpiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(7.99);
    expect(hours).toBeLessThanOrEqual(8);
    expect(new Date(header.match(/Expires=([^;]+)/)![1]!).getTime()).toBe(
      Math.floor(Date.parse(me.sessionExpiresAt) / 1000) * 1000,
    );
    expect(await staffEvents()).toEqual([
      {
        event_type: "staff_login",
        actor_staff_user_id: pl,
        subject_staff_user_id: pl,
        reason_code: null,
        details: { method: "dev" },
      },
    ]);
  });

  it("uses tp_staff over http in development", async () => {
    const { app: devApp } = testApp({ env: { nodeEnv: "development" }, db });
    const res = await devApp.request(
      "/api/v1/dev/session",
      jsonRequest("POST", { staffUserId: pl }),
    );
    expect(res.headers.getSetCookie()[0]).toMatch(
      /^tp_staff=[^;]+; Path=\/; Expires=[^;]+; HttpOnly; SameSite=Lax$/,
    );
  });

  it("reads only the staff cookie: a tampered, foreign or Slice 0 cookie is a 401", async () => {
    const { Cookie } = await login(app, pl);
    for (const cookie of [
      `${Cookie.slice(0, -2)}xx`,
      Cookie.replace(COOKIE, "tp_staff"),
      Cookie.replace(COOKIE, "__Host-tp_portal"),
      `tp_staff_session=${pl}.1`,
    ]) {
      await expectProblem(
        await app.request("/api/v1/me", { headers: { Cookie: cookie } }),
        401,
        "unauthenticated",
      );
    }
  });

  it("issues a new token at every login and supersedes the one the browser carried", async () => {
    const first = (await login(app, pl)).Cookie;
    const res = await app.request(
      "/api/v1/dev/session",
      jsonRequest("POST", { staffUserId: consultant }, { Cookie: first }),
    );
    const second = cookieOf(res, COOKIE)!;
    expect(second).not.toBe(first);
    expect(await sessionRow(first)).toMatchObject({ end_reason: "superseded" });
    await expectProblem(
      await app.request("/api/v1/me", { headers: { Cookie: first } }),
      401,
      "unauthenticated",
    );
    const me = await app.request("/api/v1/me", { headers: { Cookie: second } });
    expect(await readJson(me, StaffUser)).toMatchObject({ id: consultant });
  });

  it("is a 401 once 8 hours have passed by database time", async () => {
    const { Cookie } = await login(app, pl);
    await owner.$client.query(
      `update staff_session set created_at = now() - interval '8 hours 1 second',
         expires_at = now() - interval '1 second' where token_hash = $1`,
      [hashOf(Cookie)],
    );
    const res = await app.request("/api/v1/me", { headers: { Cookie } });
    await expectProblem(res, 401, "unauthenticated");
    // The cookie stays: a request in flight must never delete a newer login's cookie.
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("is a 401 for a deactivated account", async () => {
    const { Cookie } = await login(app, pl);
    await owner.$client.query("update staff_user set deactivated_at = now() where id = $1", [pl]);
    await expectProblem(
      await app.request("/api/v1/me", { headers: { Cookie } }),
      401,
      "unauthenticated",
    );
  });

  it("logs out with POST /auth/logout: the row ends, the cookie goes, staff_logout", async () => {
    const { Cookie } = await login(app, pl);
    const res = await app.request("/api/v1/auth/logout", jsonRequest("POST", {}, { Cookie }));
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()).toEqual([`${COOKIE}=; Max-Age=0; Path=/; Secure`]);
    expect(await sessionRow(Cookie)).toMatchObject({ end_reason: "logout" });
    await expectProblem(
      await app.request("/api/v1/me", { headers: { Cookie } }),
      401,
      "unauthenticated",
    );
    expect((await staffEvents()).at(-1)).toMatchObject({
      event_type: "staff_logout",
      actor_staff_user_id: pl,
    });
    // Without a session it still answers 204 and writes nothing.
    const again = await app.request("/api/v1/auth/logout", jsonRequest("POST", {}, { Cookie }));
    expect(again.status).toBe(204);
    expect(await staffEvents()).toHaveLength(2);
  });

  it("logs out with the dev DELETE too", async () => {
    const { Cookie } = await login(app, pl);
    const res = await app.request("/api/v1/dev/session", {
      method: "DELETE",
      headers: { Cookie, Origin: origin },
    });
    expect(res.status).toBe(204);
    expect(await sessionRow(Cookie)).toMatchObject({ end_reason: "logout" });
  });
});

describe("dev stub (AUTH_MODE=dev)", () => {
  it("lists the synthetic staff users for the switcher", async () => {
    const res = await app.request("/api/v1/dev/staff-users");
    expect(await readJson(res, z.array(StaffUser))).toHaveLength(6);
  });

  it("gives a 404 problem for an unknown staff user", async () => {
    const res = await app.request(
      "/api/v1/dev/session",
      jsonRequest("POST", { staffUserId: "00000000-0000-4000-a000-000000000000" }),
    );
    await expectProblem(res, 404, "not-found");
  });

  it("refuses a deactivated account with account_deactivated and records the refusal", async () => {
    await owner.$client.query("update staff_user set deactivated_at = now() where id = $1", [pl]);
    const res = await app.request("/api/v1/dev/session", jsonRequest("POST", { staffUserId: pl }));
    const body = await expectProblem(res, 422, "domain-error");
    expect(body.errors?.map((e) => e.code)).toEqual(["account_deactivated"]);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await staffEvents()).toEqual([
      {
        event_type: "staff_login_refused",
        actor_staff_user_id: null,
        subject_staff_user_id: pl,
        reason_code: "account_deactivated",
        details: { method: "dev" },
      },
    ]);
  });

  it("has no OIDC routes", async () => {
    await expectProblem(await app.request("/api/v1/auth/login"), 404, "not-found");
    await expectProblem(await app.request("/api/v1/auth/callback"), 404, "not-found");
  });
});

describe("OIDC login against a test issuer (AUTH_MODE=oidc, D1, D5)", () => {
  let issuer: Awaited<ReturnType<typeof createTestIssuer>>;
  let oidcApp: ReturnType<typeof testApp>;
  const clock = new ManualClock(new Date());
  const redirectUrl = `${origin}/api/v1/auth/callback`;

  beforeAll(async () => {
    issuer = await createTestIssuer();
    const env = { issuer: testIssuer, ...testClient, redirectUrl };
    oidcApp = testApp({
      env: { authMode: "oidc", oidc: env },
      db,
      clock,
      oidc: createOidc(env, { fetch: issuer.fetch }),
    });
  });
  beforeEach(() => clock.set(new Date()));

  const startLogin = async (returnTo?: string) => {
    const res = await oidcApp.app.request(
      `/api/v1/auth/login${returnTo === undefined ? "" : `?returnTo=${encodeURIComponent(returnTo)}`}`,
    );
    expect(res.status).toBe(302);
    return { location: res.headers.get("location")!, flow: cookieOf(res, "tp_oidc")!, res };
  };
  const callback = (query: string, flow: string | undefined, extra: Record<string, string> = {}) =>
    oidcApp.app.request(`/api/v1/auth/callback${query}`, {
      headers: { ...(flow && { Cookie: flow }), ...extra },
    });
  const signIn = async (claims: TestClaims, returnTo?: string) => {
    const { location, flow } = await startLogin(returnTo);
    return callback(issuer.authorize(location, claims), flow);
  };

  it("redirects to the issuer with PKCE (S256), state and nonce, kept in a signed tp_oidc cookie", async () => {
    const { location, res } = await startLogin("/projects/new");
    const url = new URL(location);
    expect(`${url.origin}${url.pathname}`).toBe(`${testIssuer}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: testClient.clientId,
      redirect_uri: redirectUrl,
      response_type: "code",
      scope: "openid profile email",
      code_challenge_method: "S256",
    });
    for (const name of ["state", "nonce", "code_challenge"]) {
      expect(url.searchParams.get(name)).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    }
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.getSetCookie()[0]).toMatch(
      /^tp_oidc=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Max-Age=600; Path=\/api\/v1\/auth; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(url.searchParams.has("code_verifier")).toBe(false);
  });

  it("binds the first login by email, case-insensitively, and starts a session", async () => {
    const res = await signIn(
      { sub: "entra-sub-pl", email: "Project-Lead@Example.ORG" },
      "/projects/new",
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/projects/new");
    const cookie = cookieOf(res, COOKIE)!;
    expect(cookieOf(res, "tp_oidc")).toBe("tp_oidc=");
    expect(await sessionRow(cookie)).toEqual({
      staff_user_id: pl,
      end_reason: null,
      eight_hours: true,
    });
    expect(await identityOf(pl)).toEqual({ oidc_issuer: testIssuer, oidc_subject: "entra-sub-pl" });
    expect(await staffEvents()).toEqual([
      {
        event_type: "staff_identity_bound",
        actor_staff_user_id: pl,
        subject_staff_user_id: pl,
        reason_code: null,
        details: { matchedBy: "email" },
      },
      {
        event_type: "staff_login",
        actor_staff_user_id: pl,
        subject_staff_user_id: pl,
        reason_code: null,
        details: { method: "oidc" },
      },
    ]);
    const me = await oidcApp.app.request("/api/v1/me", { headers: { Cookie: cookie } });
    expect(await readJson(me, CurrentStaffUser)).toMatchObject({ id: pl });
    // PKCE: the token request carried the verifier, and the client authenticated.
    const token = issuer.tokenRequests.at(-1)!;
    expect(token.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(token.get("client_secret")).toBe(testClient.clientSecret);
  });

  it("matches by preferred_username without an email claim", async () => {
    const res = await signIn({ sub: "entra-sub-c", preferred_username: "consultant@example.org" });
    expect(res.headers.get("location")).toBe("/");
    expect(await identityOf(consultant)).toEqual({
      oidc_issuer: testIssuer,
      oidc_subject: "entra-sub-c",
    });
    expect((await staffEvents())[0]).toMatchObject({
      details: { matchedBy: "preferred_username" },
    });
  });

  it("matches later logins by (iss, sub) only", async () => {
    await signIn({ sub: "entra-sub-pl", email: "project-lead@example.org" });
    // The claim now names another account: the bound identity decides.
    const res = await signIn({ sub: "entra-sub-pl", email: "consultant@example.org" });
    expect(await sessionRow(cookieOf(res, COOKIE)!)).toMatchObject({ staff_user_id: pl });
    expect(await identityOf(consultant)).toEqual({ oidc_issuer: null, oidc_subject: null });
    expect((await staffEvents()).map((e) => e.event_type)).toEqual([
      "staff_identity_bound",
      "staff_login",
      "staff_login",
    ]);
  });

  it.each([
    ["unknown_account", { sub: "entra-sub-x", email: "nobody@example.org" }, async () => {}, null],
    ["unknown_account without a name claim", { sub: "entra-sub-x" }, async () => {}, null],
    [
      "account_deactivated",
      { sub: "entra-sub-pl", email: "project-lead@example.org" },
      () => owner.$client.query("update staff_user set deactivated_at = now() where id = $1", [pl]),
      pl,
    ],
    [
      "identity_mismatch",
      { sub: "entra-sub-other", email: "project-lead@example.org" },
      () =>
        owner.$client.query(
          "update staff_user set oidc_issuer = $1, oidc_subject = 'entra-sub-pl' where id = $2",
          [testIssuer, pl],
        ),
      pl,
    ],
  ])(
    "refuses %s with its code and a staff_login_refused row without the email",
    async (label, claims, arrange, subject) => {
      await arrange();
      const sessions = "select count(*)::int as n from staff_session";
      const sessionsBefore = (await owner.$client.query(sessions)).rows[0].n;
      const before = oidcApp.logs.length;
      const res = await signIn(claims);
      const code = label.split(" ")[0]!;
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`/login?error=${code}`);
      expect(cookieOf(res, COOKIE)).toBeUndefined();
      const events = await staffEvents();
      expect(events).toEqual([
        {
          event_type: "staff_login_refused",
          actor_staff_user_id: null,
          subject_staff_user_id: subject,
          reason_code: code,
          details: { method: "oidc" },
        },
      ]);
      const written = JSON.stringify(events) + oidcApp.logs.slice(before).join("\n");
      for (const value of Object.values(claims as TestClaims)) {
        expect(written.toLowerCase()).not.toContain(value.toLowerCase());
      }
      expect((await owner.$client.query(sessions)).rows[0].n).toBe(sessionsBefore);
    },
  );

  it("refuses a deactivated bound account", async () => {
    await signIn({ sub: "entra-sub-pl", email: "project-lead@example.org" });
    await owner.$client.query("update staff_user set deactivated_at = now() where id = $1", [pl]);
    const res = await signIn({ sub: "entra-sub-pl", email: "project-lead@example.org" });
    expect(res.headers.get("location")).toBe("/login?error=account_deactivated");
  });

  describe("fails a callback that doesn't pass its checks (login_failed)", () => {
    const claims = { sub: "entra-sub-pl", email: "project-lead@example.org" };
    /** What a refused callback leaves: a redirect to the login page, and nothing written. */
    const failed = {
      status: 302,
      location: "/login?error=login_failed",
      session: undefined,
      identity: { oidc_issuer: null, oidc_subject: null },
      events: [],
    };
    it("a state that differs", async () => {
      const { location, flow } = await startLogin();
      expect(
        await outcome(
          await callback(issuer.authorize(location, claims, { state: "x".repeat(43) }), flow),
        ),
      ).toEqual(failed);
    });

    it("a nonce that differs", async () => {
      const { location, flow } = await startLogin();
      expect(
        await outcome(
          await callback(issuer.authorize(location, claims, { nonce: "n".repeat(43) }), flow),
        ),
      ).toEqual(failed);
    });

    it("a PKCE verifier that doesn't fit the challenge the issuer saw", async () => {
      const { location, flow } = await startLogin();
      expect(
        await outcome(
          await callback(
            issuer.authorize(location, claims, { codeChallenge: "c".repeat(43) }),
            flow,
          ),
        ),
      ).toEqual(failed);
    });

    it("no flow cookie, a tampered one, or one of another login", async () => {
      const first = await startLogin();
      const second = await startLogin();
      const query = issuer.authorize(first.location, claims);
      expect(await outcome(await callback(query, undefined))).toEqual(failed);
      const [payload, signature] = first.flow.slice("tp_oidc=".length).split(".");
      expect(await outcome(await callback(query, `tp_oidc=${payload}x.${signature}`))).toEqual(
        failed,
      );
      expect(await outcome(await callback(query, second.flow))).toEqual(failed);
    });

    it("a flow older than 10 minutes", async () => {
      const { location, flow } = await startLogin();
      clock.set(new Date(Date.now() + 10 * 60_000 + 1000));
      expect(await outcome(await callback(issuer.authorize(location, claims), flow))).toEqual(
        failed,
      );
    });

    it("an error from the issuer", async () => {
      const { flow } = await startLogin();
      expect(await outcome(await callback("?error=access_denied&state=x", flow))).toEqual(failed);
    });

    it("clears the flow cookie at the callback", async () => {
      const { location, flow } = await startLogin();
      const query = issuer.authorize(location, claims);
      const res = await callback(query, flow);
      expect(res.headers.get("location")).toBe("/");
      expect(cookieOf(res, "tp_oidc")).toBe("tp_oidc=");
    });
  });

  it.each(["https://evil.example.org/", "//evil.example.org", "/api/v1/me", "/portal/"])(
    "returns to / for the return path %s",
    async (returnTo) => {
      const res = await signIn(
        { sub: "entra-sub-pl", email: "project-lead@example.org" },
        returnTo,
      );
      expect(res.headers.get("location")).toBe("/");
    },
  );

  it("never logs a token, cookie, code, claim or email", async () => {
    const { logs } = oidcApp;
    const before = logs.length;
    const { location, flow } = await startLogin();
    const query = issuer.authorize(location, {
      sub: "entra-sub-pl",
      email: "project-lead@example.org",
    });
    const res = await callback(query, flow);
    const cookie = cookieOf(res, COOKIE)!;
    await oidcApp.app.request("/api/v1/me", { headers: { Cookie: cookie } });
    await callback("?error=access_denied&state=x", flow);
    const written = logs.slice(before).join("\n");
    const code = new URLSearchParams(query).get("code")!;
    for (const secret of [
      "project-lead@example.org",
      "entra-sub-pl",
      code,
      cookie.split("=")[1]!,
      flow.split("=")[1]!.split(".")[0]!,
      new URL(location).searchParams.get("state")!,
      testClient.clientSecret,
    ]) {
      expect(written).not.toContain(secret);
    }
    expect(logs.slice(before).map((line) => JSON.parse(line).route)).toContain(
      "/api/v1/auth/callback",
    );
  });

  it("has no dev routes", async () => {
    await expectProblem(await oidcApp.app.request("/api/v1/dev/staff-users"), 404, "not-found");
  });

  it("sends a failing discovery to the login page and retries it at the next login", async () => {
    let down = true;
    const env = { issuer: testIssuer, ...testClient, redirectUrl };
    const flaky = testApp({
      env: { authMode: "oidc", oidc: env },
      db,
      oidc: createOidc(env, {
        fetch: ((input: string | URL | Request, init?: RequestInit) =>
          down
            ? Promise.reject(new Error("unreachable"))
            : issuer.fetch(input, init)) as typeof fetch,
      }),
    });
    const failed = await flaky.app.request("/api/v1/auth/login");
    expect(failed.headers.get("location")).toBe("/login?error=login_failed");
    down = false;
    const res = await flaky.app.request("/api/v1/auth/login");
    expect(res.headers.get("location")).toMatch(/^https:\/\/issuer\.test\//);
  });
});

/** Every unsafe operation of the OpenAPI document, with a placeholder for each path id. */
const unsafeRoutes = async () => {
  const doc = (await (await app.request("/api/v1/openapi.json")).json()) as {
    paths: Record<string, Record<string, unknown>>;
  };
  return Object.entries(doc.paths as Record<string, Record<string, unknown>>).flatMap(
    ([path, operations]) =>
      Object.keys(operations)
        .filter((m) => ["post", "put", "patch", "delete"].includes(m))
        .map((method) => ({
          method: method.toUpperCase(),
          path: `/api/v1${path.replaceAll(/\{[^}]+\}/g, "00000000-0000-4000-a000-000000000000")}`,
        })),
  );
};

describe("CSRF (D4)", () => {
  it("refuses every unsafe route from a foreign origin, or without Origin and Sec-Fetch-Site: same-origin", async () => {
    const { Cookie } = await login(app, pl);
    const routes = await unsafeRoutes();
    expect(routes.length).toBeGreaterThan(20);
    for (const { method, path } of routes) {
      for (const headers of <Record<string, string>[]>[
        { Origin: "https://evil.example" },
        { Origin: "null" },
        {},
        { "Sec-Fetch-Site": "same-site" },
        { "Sec-Fetch-Site": "cross-site" },
        { Origin: "https://evil.example", "Sec-Fetch-Site": "same-origin" },
      ]) {
        const res = await app.request(path, {
          method,
          body: method === "DELETE" ? undefined : "{}",
          headers: { Cookie, "Content-Type": "application/json", ...headers },
        });
        const body = await expectProblem(res, 403, "forbidden");
        expect(body.errors).toEqual([
          { pointer: "", code: "csrf_origin", detail: "The request's origin is not allowed" },
        ]);
      }
    }
  });

  it("checks every content type, not only forms", async () => {
    const { Cookie } = await login(app, pl);
    for (const type of ["application/x-www-form-urlencoded", "text/plain", "application/json"]) {
      const res = await app.request("/api/v1/projects", {
        method: "POST",
        body: "{}",
        headers: { Cookie, Origin: "https://evil.example", "Content-Type": type },
      });
      await expectProblem(res, 403, "forbidden");
    }
  });

  it("lets an allowed Origin, or Sec-Fetch-Site: same-origin without one, through", async () => {
    const { Cookie } = await login(app, pl);
    const logout = (headers: Record<string, string>) =>
      app.request("/api/v1/auth/logout", {
        method: "POST",
        body: "{}",
        headers: { Cookie, "Content-Type": "application/json", ...headers },
      });
    expect((await logout({ Origin: origin })).status).toBe(204);
    expect((await logout({ "Sec-Fetch-Site": "same-origin" })).status).toBe(204);
  });

  it("leaves safe methods alone", async () => {
    const res = await app.request("/api/v1/health", {
      headers: { Origin: "https://evil.example" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a POST without a JSON body with a 415 problem", async () => {
    const res = await app.request("/api/v1/projects", {
      method: "POST",
      headers: { ...(await login(app, pl)), Origin: origin },
    });
    await expectProblem(res, 415, "unsupported-media-type");
  });
});
