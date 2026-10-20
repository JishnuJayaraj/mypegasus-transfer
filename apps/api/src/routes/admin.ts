import { createRoute, z } from "@hono/zod-openapi";
import { and, asc, eq, isNull, region, sql, staffUser } from "@transfer/db";
import {
  CreateRegionInput,
  CreateStaffUserInput,
  isGlobalAdmin,
  orgRoleChanges,
  PageQuery,
  readsStaffDirectory,
  Region,
  SetOrgRolesInput,
  StaffAccount,
  StaffAccountPage,
  StaffDirectoryEntry,
  StaffDirectoryQuery,
  UpdateRegionInput,
  UpdateStaffUserInput,
  type OrgRoleGrant,
  type StaffUser,
} from "@transfer/domain";
import type { Context } from "hono";
import { staffSubjectOf } from "../access";
import { createRouter, json, type Deps } from "../context";
import { decodeCursor, encodeCursor } from "../cursor";
import { functionRefusal } from "../database-errors";
import { domainProblem, problem, problemResponses } from "../problem";
import { requireSession, sessionUser } from "../session";
import { callFunction, utc } from "../sql";

// Org administration (Q126): only a global admin creates, changes and deactivates staff accounts,
// grants org roles, sets `mayCreateProjects` and maintains the regions. The functions check the
// admin again and write the staff audit events; names and emails never enter them.

const StaffUserParams = z.object({ staffUserId: z.uuid() });
const RegionParams = z.object({ regionId: z.uuid() });
const RegionList = z.array(Region).meta({ id: "RegionList" });
const StaffDirectory = z.array(StaffDirectoryEntry).meta({ id: "StaffDirectory" });

/** Member pickers list at most this many matches; the PL narrows the search instead. */
const directoryLimit = 20;

const accountColumns = {
  id: staffUser.id,
  displayName: staffUser.displayName,
  email: staffUser.email,
  mayCreateProjects: staffUser.mayCreateProjects,
  orgRoles: sql<
    OrgRoleGrant[]
  >`coalesce((select json_agg(json_build_object('role', r.role, 'regionId', r.region_id) order by r.role, r.region_id) from staff_org_role r where r.staff_user_id = staff_user.id), '[]')`,
  identityBound: sql<boolean>`${staffUser.oidcSubject} is not null`,
  deactivatedAt: sql<
    string | null
  >`case when ${staffUser.deactivatedAt} is null then null else ${utc(staffUser.deactivatedAt)} end`,
  createdAt: utc(staffUser.createdAt),
};

const regionColumns = {
  id: region.id,
  code: region.code,
  name: region.name,
  createdAt: utc(region.createdAt),
};

/** A function's refusal, if it is one of `codes`; anything else propagates (a 500). */
function refusalIn(error: unknown, codes: readonly string[]) {
  const code = functionRefusal(error);
  if (code !== undefined && codes.includes(code)) return code;
  throw error;
}

/** Where a refusal points in the body (ADR-0010): the field it belongs to, if any. */
const fieldOf: Record<string, string> = {
  email_taken: "email",
  region_code_taken: "code",
  region_not_found: "orgRoles",
};
const asProblem = (c: Context, code: string) =>
  domainProblem(c, [{ code, field: fieldOf[code] ?? null }]);

export function adminRoutes(deps: Deps) {
  const { db } = deps;
  const router = createRouter();
  const middleware = [requireSession(deps)];

  /** The global admin, else a 403 (Q126). */
  const isAdmin = async (user: StaffUser) => isGlobalAdmin(await staffSubjectOf(db, user));
  const accountOf = async (id: string) =>
    (await db.select(accountColumns).from(staffUser).where(eq(staffUser.id, id)))[0];

  router.openapi(
    createRoute({
      method: "get",
      path: "/regions",
      tags: ["admin"],
      summary: "The regions (Niederlassungen), by code: reference data every staff user may read",
      middleware,
      responses: { 200: json(RegionList, "All regions"), ...problemResponses("unauthenticated") },
    }),
    async (c) => c.json(await db.select(regionColumns).from(region).orderBy(asc(region.code)), 200),
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/regions",
      tags: ["admin"],
      summary: "Create a region (the global admin)",
      middleware,
      request: {
        body: { required: true, content: { "application/json": { schema: CreateRegionInput } } },
      },
      responses: {
        201: json(Region, "The new region"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "unsupported-media-type",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const user = sessionUser(c);
      if (!(await isAdmin(user))) return problem(c, "forbidden");
      const { code, name } = c.req.valid("json");
      const result = await callFunction(
        db,
        sql`create_region(p_code => ${code}, p_name => ${name}, p_actor => ${user.id}::uuid,
          p_request_id => ${c.get("requestId")})`,
      ).catch((error: unknown) => ({ refused: refusalIn(error, ["region_code_taken"]) }));
      if (typeof result !== "string") return asProblem(c, result.refused);
      const [created] = await db.select(regionColumns).from(region).where(eq(region.id, result));
      return c.json(created!, 201);
    },
  );

  router.openapi(
    createRoute({
      method: "patch",
      path: "/regions/{regionId}",
      tags: ["admin"],
      summary: "Change a region's code or name (the global admin)",
      middleware,
      request: {
        params: RegionParams,
        body: { required: true, content: { "application/json": { schema: UpdateRegionInput } } },
      },
      responses: {
        200: json(Region, "The changed region"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "unsupported-media-type",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const user = sessionUser(c);
      if (!(await isAdmin(user))) return problem(c, "forbidden");
      const { regionId } = c.req.valid("param");
      const { code, name } = c.req.valid("json");
      const refused = await callFunction(
        db,
        sql`update_region(p_id => ${regionId}::uuid, p_actor => ${user.id}::uuid,
          p_request_id => ${c.get("requestId")}, p_code => ${code ?? null}::text,
          p_name => ${name ?? null}::text)`,
      ).then(
        () => null,
        (error: unknown) =>
          refusalIn(error, ["region_not_found", "region_unchanged", "region_code_taken"]),
      );
      if (refused === "region_not_found") return problem(c, "not-found");
      if (refused) return asProblem(c, refused);
      const [changed] = await db.select(regionColumns).from(region).where(eq(region.id, regionId));
      return c.json(changed!, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/staff-users",
      tags: ["admin"],
      summary:
        "Staff accounts with their org roles, oldest first (the global admin; cursor pagination)",
      middleware,
      request: { query: PageQuery },
      responses: {
        200: json(StaffAccountPage, "A page of staff accounts"),
        ...problemResponses("validation-error", "unauthenticated", "forbidden"),
      },
    }),
    async (c) => {
      const { limit, cursor: rawCursor } = c.req.valid("query");
      const cursor = rawCursor === undefined ? undefined : decodeCursor(rawCursor);
      if (rawCursor !== undefined && !cursor) {
        return problem(c, "validation-error", {
          errors: [{ parameter: "cursor", code: "invalid_cursor", detail: "Malformed cursor" }],
        });
      }
      if (!(await isAdmin(sessionUser(c)))) return problem(c, "forbidden");
      const rows = await db
        .select(accountColumns)
        .from(staffUser)
        .where(
          cursor &&
            sql`(${staffUser.createdAt}, ${staffUser.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
        )
        .orderBy(asc(staffUser.createdAt), asc(staffUser.id))
        .limit(limit + 1);
      const items = rows.slice(0, limit);
      const last = items.at(-1);
      const nextCursor =
        rows.length > limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null;
      return c.json({ items, nextCursor }, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/staff-users",
      tags: ["admin"],
      summary: "Create a staff account (the global admin); its first OIDC login binds the identity",
      middleware,
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: CreateStaffUserInput } },
        },
      },
      responses: {
        201: json(StaffAccount, "The new staff account"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "unsupported-media-type",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const user = sessionUser(c);
      if (!(await isAdmin(user))) return problem(c, "forbidden");
      const input = c.req.valid("json");
      const result = await callFunction(
        db,
        sql`create_staff_user(p_display_name => ${input.displayName}, p_email => ${input.email},
          p_may_create_projects => ${input.mayCreateProjects}, p_actor => ${user.id}::uuid,
          p_request_id => ${c.get("requestId")})`,
      ).catch((error: unknown) => ({ refused: refusalIn(error, ["email_taken"]) }));
      if (typeof result !== "string") return asProblem(c, result.refused);
      return c.json((await accountOf(result))!, 201);
    },
  );

  router.openapi(
    createRoute({
      method: "patch",
      path: "/staff-users/{staffUserId}",
      tags: ["admin"],
      summary: "Change an active account's name, email or project-creation flag (the global admin)",
      middleware,
      request: {
        params: StaffUserParams,
        body: {
          required: true,
          content: { "application/json": { schema: UpdateStaffUserInput } },
        },
      },
      responses: {
        200: json(StaffAccount, "The changed staff account"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "unsupported-media-type",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const user = sessionUser(c);
      if (!(await isAdmin(user))) return problem(c, "forbidden");
      const { staffUserId } = c.req.valid("param");
      const input = c.req.valid("json");
      const refused = await callFunction(
        db,
        sql`update_staff_user(p_id => ${staffUserId}::uuid, p_actor => ${user.id}::uuid,
          p_request_id => ${c.get("requestId")},
          p_display_name => ${input.displayName ?? null}::text,
          p_email => ${input.email ?? null}::text,
          p_may_create_projects => ${input.mayCreateProjects ?? null}::boolean)`,
      ).then(
        () => null,
        (error: unknown) =>
          refusalIn(error, [
            "unknown_account",
            "account_deactivated",
            "staff_user_unchanged",
            "email_taken",
          ]),
      );
      if (refused === "unknown_account") return problem(c, "not-found");
      if (refused) return asProblem(c, refused);
      return c.json((await accountOf(staffUserId))!, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: "/staff-users/{staffUserId}/deactivation",
      tags: ["admin"],
      summary:
        "Deactivate an account (the global admin, never their own): ends its sessions, memberships and assignments; refused for a project's last active PL",
      middleware,
      request: {
        params: StaffUserParams,
        body: { required: true, content: { "application/json": { schema: z.strictObject({}) } } },
      },
      responses: {
        200: json(StaffAccount, "The deactivated account"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "unsupported-media-type",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const user = sessionUser(c);
      if (!(await isAdmin(user))) return problem(c, "forbidden");
      const { staffUserId } = c.req.valid("param");
      const refused = await db
        .execute(
          sql`select deactivate_staff_user(p_id => ${staffUserId}::uuid, p_actor => ${user.id}::uuid,
            p_request_id => ${c.get("requestId")})`,
        )
        .then(
          () => null,
          (error: unknown) =>
            refusalIn(error, [
              "unknown_account",
              "account_deactivated",
              "own_account",
              "last_project_lead",
            ]),
        );
      if (refused === "unknown_account") return problem(c, "not-found");
      if (refused) return asProblem(c, refused);
      return c.json((await accountOf(staffUserId))!, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "put",
      path: "/staff-users/{staffUserId}/org-roles",
      tags: ["admin"],
      summary:
        "Set an account's org roles (the global admin): admin globally, the regional roles per region",
      middleware,
      request: {
        params: StaffUserParams,
        body: { required: true, content: { "application/json": { schema: SetOrgRolesInput } } },
      },
      responses: {
        200: json(StaffAccount, "The account with its org roles"),
        ...problemResponses(
          "validation-error",
          "unauthenticated",
          "forbidden",
          "not-found",
          "unsupported-media-type",
          "domain-error",
        ),
      },
    }),
    async (c) => {
      const user = sessionUser(c);
      if (!(await isAdmin(user))) return problem(c, "forbidden");
      const { staffUserId } = c.req.valid("param");
      const account = await accountOf(staffUserId);
      if (!account) return problem(c, "not-found");
      const { grant, revoke } = orgRoleChanges(account.orgRoles, c.req.valid("json").orgRoles);
      const refused = await db
        .transaction(async (tx) => {
          const call = (
            fn: "grant_org_role" | "revoke_org_role",
            { role, regionId }: OrgRoleGrant,
          ) =>
            tx.execute(
              sql`select ${sql.raw(fn)}(p_staff_user_id => ${staffUserId}::uuid,
                p_role => ${role}::org_role, p_region_id => ${regionId}::uuid,
                p_actor => ${user.id}::uuid, p_request_id => ${c.get("requestId")})`,
            );
          for (const role of revoke) await call("revoke_org_role", role);
          for (const role of grant) await call("grant_org_role", role);
          return null;
        })
        .catch((error: unknown) =>
          refusalIn(error, [
            "account_deactivated",
            "own_account",
            "region_not_found",
            "org_role_exists",
            "org_role_not_found",
          ]),
        );
      if (refused) return asProblem(c, refused);
      return c.json((await accountOf(staffUserId))!, 200);
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: "/staff-directory",
      tags: ["admin"],
      summary:
        "Active staff whose name contains `search`: id and name only, for member pickers (a PL or the global admin)",
      middleware,
      request: { query: StaffDirectoryQuery },
      responses: {
        200: json(StaffDirectory, `At most ${directoryLimit} matches, by name`),
        ...problemResponses("validation-error", "unauthenticated", "forbidden"),
      },
    }),
    async (c) => {
      const subject = await staffSubjectOf(db, sessionUser(c));
      if (!readsStaffDirectory(subject)) return problem(c, "forbidden");
      const pattern = `%${c.req.valid("query").search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      const entries = await db
        .select({ id: staffUser.id, displayName: staffUser.displayName })
        .from(staffUser)
        .where(and(isNull(staffUser.deactivatedAt), sql`${staffUser.displayName} ilike ${pattern}`))
        .orderBy(asc(staffUser.displayName), asc(staffUser.id))
        .limit(directoryLimit);
      return c.json(entries, 200);
    },
  );

  return router;
}
