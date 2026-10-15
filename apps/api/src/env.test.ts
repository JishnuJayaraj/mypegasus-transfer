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

describe("parseEnv", () => {
  it("parses the dev defaults and generates a session secret", () => {
    const env = parseEnv(dev);
    expect(env).toMatchObject({
      nodeEnv: "development",
      authMode: "dev",
      appOrigins: ["http://localhost:5173", "http://localhost:5174"],
      port: 3001,
      logLevel: "info",
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

  it("refuses AUTH_MODE=oidc until Slice 3", () => {
    expect(() => parseEnv({ ...dev, AUTH_MODE: "oidc" })).toThrow(/not implemented until Slice 3/);
  });

  it("requires SESSION_SECRET outside development", () => {
    expect(() => parseEnv({ ...dev, NODE_ENV: "test" })).toThrow(/SESSION_SECRET/);
  });

  it("names invalid variables but never their values", () => {
    expect(parseInvalid).toThrow(/DATABASE_URL/);
    expect(parseInvalid).toThrow(/AUTH_MODE/);
    expect(parseInvalid).not.toThrow(/Zzyzx/);
  });
});
