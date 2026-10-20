import { OpenAPIHono } from "@hono/zod-openapi";
import type { Clock } from "@transfer/adapters";
import type { Database } from "@transfer/db";
import type { StaffUser } from "@transfer/domain";
import type { Logger } from "pino";
import type { z } from "zod";
import type { Env } from "./env";
import { validationProblem } from "./problem";
import type { Slots } from "./imports/slots";
import type { SpaRoots } from "./static";
import type { Oidc } from "./oidc";

export interface Deps {
  db: Database;
  env: Env;
  logger: Logger;
  /** The only source of the current time (ADR-0006, plan 5.8). */
  clock: Clock;
  /** The built SPAs to serve (production image, `pnpm start`); Vite serves them in dev. */
  spa?: SpaRoots | undefined;
  /** The parse-worker slots of the import (R43); the process's own by default, a test's own. */
  importSlots?: Slots | undefined;
  /** The OIDC client (AUTH_MODE=oidc); built from the environment unless a test injects one. */
  oidc?: Oidc | undefined;
}

export interface AppEnv {
  Variables: {
    requestId: string;
    staffUser: StaffUser | undefined;
    /** When the request's staff session ends (ISO 8601 UTC), behind `requireSession`. */
    sessionExpiresAt: string | undefined;
  };
}

/** A router whose Zod validation failures become RFC 9457 validation problems. */
export function createRouter() {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return validationProblem(c, result.error, result.target);
    },
  });
}

export type Router = ReturnType<typeof createRouter>;

/** The OpenAPI entry of a JSON response with `schema`. */
export const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
