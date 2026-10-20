import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

const dev = {
  NODE_ENV: "development",
  AUTH_MODE: "dev",
  DATABASE_URL: "postgres://transfer_app:transfer_app_dev@localhost:5432/transfer",
  APP_ORIGINS: "http://localhost:5173,http://localhost:5174",
};

const parseInvalid = () =>
  parseEnv({ ...dev, DATABASE_URL: undefined, AUTH_MODE: "Zzyzx-secret", LOG_LEVEL: "loud" });

const parseMalformedRunTime = () => parseEnv({ ...dev, JOBS_LIFECYCLE_TIME: "4:15am" });

describe("parseEnv", () => {
  it("parses the dev defaults and generates a session secret", () => {
    const env = parseEnv(dev);
    expect(env).toMatchObject({
      nodeEnv: "development",
      authMode: "dev",
      appOrigins: ["http://localhost:5173", "http://localhost:5174"],
      port: 3001,
      logLevel: "info",
      jobsEnabled: true,
      jobsLifecycleTime: "04:15",
      clock: "system",
    });
    expect(env.sessionSecret.length).toBeGreaterThanOrEqual(32);
  });

  it("treats empty variables as unset, as in the .env copied from .env.example", () => {
    const env = parseEnv({ ...dev, SESSION_SECRET: "", PORT: "", LOG_LEVEL: "" });
    expect(env.sessionSecret.length).toBeGreaterThanOrEqual(32);
    expect(env).toMatchObject({ port: 3001, logLevel: "info" });
    expect(() => parseEnv({ ...dev, NODE_ENV: "test", SESSION_SECRET: "" })).toThrow(
      /SESSION_SECRET is required/,
    );
  });

  it("prefers PORT over API_PORT", () => {
    expect(parseEnv({ ...dev, API_PORT: "4000" }).port).toBe(4000);
    expect(parseEnv({ ...dev, API_PORT: "4000", PORT: "8080" }).port).toBe(8080);
  });

  it("refuses AUTH_MODE=dev in production", () => {
    expect(() =>
      parseEnv({ ...dev, NODE_ENV: "production", SESSION_SECRET: "s".repeat(32) }),
    ).toThrow(/AUTH_MODE=dev is not allowed with NODE_ENV=production/);
  });

  // Slice 3 plan, D1 (PR 3b).
  describe("AUTH_MODE=oidc", () => {
    const oidc = {
      ...dev,
      AUTH_MODE: "oidc",
      OIDC_ISSUER: "https://login.example.org/tenant/v2.0",
      OIDC_CLIENT_ID: "transfer-web",
      OIDC_CLIENT_SECRET: "Zzyzx-client-secret",
      OIDC_REDIRECT_URL: "http://localhost:5173/api/v1/auth/callback",
    };
    const production = {
      ...oidc,
      NODE_ENV: "production",
      SESSION_SECRET: "s".repeat(32),
      APP_ORIGINS: "https://transfer.example.org",
      OIDC_REDIRECT_URL: "https://transfer.example.org/api/v1/auth/callback",
    };

    it("starts with its four variables set", () => {
      expect(parseEnv(oidc)).toMatchObject({
        authMode: "oidc",
        oidc: {
          issuer: oidc.OIDC_ISSUER,
          clientId: "transfer-web",
          clientSecret: "Zzyzx-client-secret",
          redirectUrl: oidc.OIDC_REDIRECT_URL,
        },
      });
      expect(parseEnv(production).oidc?.redirectUrl).toBe(production.OIDC_REDIRECT_URL);
      expect(parseEnv(dev).oidc).toBeUndefined();
    });

    it.each(["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URL"])(
      "refuses to start without %s, naming it",
      (name) => {
        expect(() => parseEnv({ ...oidc, [name]: "" })).toThrow(
          new RegExp(`AUTH_MODE=oidc needs ${name}`),
        );
      },
    );

    it("needs https outside development", () => {
      expect(() =>
        parseEnv({ ...production, OIDC_ISSUER: "http://login.example.org/tenant" }),
      ).toThrow(/OIDC_ISSUER must be https/);
      expect(() =>
        parseEnv({
          ...production,
          APP_ORIGINS: "http://transfer.example.org",
          OIDC_REDIRECT_URL: "http://transfer.example.org/api/v1/auth/callback",
        }),
      ).toThrow(/OIDC_REDIRECT_URL must be https/);
    });

    it.each([
      "https://other.example.org/api/v1/auth/callback",
      "http://localhost:5173/callback",
      "http://localhost:5173/api/v1/auth/callback?x=1",
    ])("refuses the redirect URL %s", (url) => {
      expect(() => parseEnv({ ...oidc, OIDC_REDIRECT_URL: url })).toThrow(
        /OIDC_REDIRECT_URL must be \/api\/v1\/auth\/callback on an origin in APP_ORIGINS/,
      );
    });

    it("never puts the client secret into an error", () => {
      expect(() => parseEnv({ ...oidc, OIDC_ISSUER: "not a url" })).toThrow(/OIDC_ISSUER/);
      expect(() => parseEnv({ ...oidc, OIDC_ISSUER: "not a url" })).not.toThrow(/Zzyzx/);
    });
  });

  it("requires SESSION_SECRET outside development", () => {
    expect(() => parseEnv({ ...dev, NODE_ENV: "test" })).toThrow(/SESSION_SECRET/);
  });

  it("names invalid variables but never their values", () => {
    expect(parseInvalid).toThrow(/DATABASE_URL/);
    expect(parseInvalid).toThrow(/AUTH_MODE/);
    expect(parseInvalid).not.toThrow(/Zzyzx/);
  });

  // Plan 5.8, 5.9 (PR 1h-1).
  it("parses the jobs switch, the Berlin run time and the clock", () => {
    expect(
      parseEnv({
        ...dev,
        JOBS_ENABLED: "false",
        JOBS_LIFECYCLE_TIME: "05:30",
        CLOCK: "fixed:2091-03-01T03:15:00Z",
      }),
    ).toMatchObject({
      jobsEnabled: false,
      jobsLifecycleTime: "05:30",
      clock: "fixed:2091-03-01T03:15:00Z",
    });
    expect(parseEnv({ ...dev, JOBS_ENABLED: "", JOBS_LIFECYCLE_TIME: "" })).toMatchObject({
      jobsEnabled: true,
      jobsLifecycleTime: "04:15",
    });
    expect(() => parseEnv({ ...dev, JOBS_ENABLED: "yes" })).toThrow(/JOBS_ENABLED/);
  });

  it.each(["02:00", "02:59"])(
    "refuses the run time %s, which doesn't exist or repeats on the DST days (round 9)",
    (time) => {
      expect(() => parseEnv({ ...dev, JOBS_LIFECYCLE_TIME: time })).toThrow(
        /JOBS_LIFECYCLE_TIME: Run times from 02:00 to 02:59 are not allowed/,
      );
    },
  );

  it("refuses a malformed run time without echoing it", () => {
    expect(parseMalformedRunTime).toThrow(/JOBS_LIFECYCLE_TIME: Expected a run time HH:MM/);
    expect(parseMalformedRunTime).not.toThrow(/4:15am/);
  });

  it("refuses an invalid clock, and a fixed clock in production", () => {
    expect(() => parseEnv({ ...dev, CLOCK: "fixed:yesterday" })).toThrow(/Invalid CLOCK/);
    expect(() =>
      parseEnv({
        ...dev,
        NODE_ENV: "production",
        SESSION_SECRET: "s".repeat(32),
        CLOCK: "fixed:2091-03-01T03:15:00Z",
      }),
    ).toThrow(/CLOCK=fixed is not allowed with NODE_ENV=production/);
  });
});
