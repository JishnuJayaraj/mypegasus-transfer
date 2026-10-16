import { OpenAPIHono } from "@hono/zod-openapi";
import type { Clock } from "@transfer/adapters";
import type { Database } from "@transfer/db";
import type { StaffUser } from "@transfer/domain";
import type { Logger } from "pino";
import type { Env } from "./env";
import { validationProblem } from "./problem";
import type { SpaRoots } from "./static";

export interface Deps {
  db: Database;
  env: Env;
  logger: Logger;
  /** The only source of the current time (ADR-0006, plan 5.8). */
  clock: Clock;
  /** The built SPAs to serve (production image, `pnpm start`); Vite serves them in dev. */
  spa?: SpaRoots | undefined;
}

export interface AppEnv {
  Variables: { requestId: string; staffUser: StaffUser | undefined };
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
