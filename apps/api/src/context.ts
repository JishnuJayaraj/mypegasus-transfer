import { OpenAPIHono } from "@hono/zod-openapi";
import type { Database } from "@transfer/db";
import type { StaffUser } from "@transfer/domain";
import type { Logger } from "pino";
import type { Env } from "./env";
import { validationProblem } from "./problem";

export interface Deps {
  db: Database;
  env: Env;
  logger: Logger;
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
