import { sql } from "@transfer/db";
import {
  staffLoginDecision,
  StaffLoginRefusal,
  type StaffLoginAccount,
  type StaffLoginMethod,
} from "@transfer/domain";
import type { Context } from "hono";
import type { AppEnv, Deps } from "./context";
import { functionRefusal } from "./database-errors";
import type { OidcIdentity } from "./oidc";
import { startSession } from "./session";

// Staff login for both modes (Slice 3 plan D1, D5, D6): the account decision, the binding of a
// first OIDC login and the session start in one transaction; a refusal is recorded by its code
// (`staff_login_refused`), never with the claimed name.

export type LoginResult = { ok: true; expiresAt: string } | { ok: false; code: StaffLoginRefusal };

const refusalCode = (error: unknown) => {
  const code = StaffLoginRefusal.safeParse(functionRefusal(error));
  return code.success ? code.data : undefined;
};

async function recordRefusal(
  c: Context<AppEnv>,
  { db }: Deps,
  method: StaffLoginMethod,
  code: StaffLoginRefusal,
  staffUserId: string | null,
): Promise<LoginResult> {
  await db.execute(sql`select record_staff_login_refused(
    p_reason_code => ${code}, p_subject_staff_user_id => ${staffUserId}::uuid,
    p_method => ${method}, p_request_id => ${c.get("requestId")}) as result`);
  return { ok: false, code };
}

const accountColumns = sql`id, oidc_issuer as "oidcIssuer", oidc_subject as "oidcSubject",
  deactivated_at is not null as deactivated`;

/**
 * An OIDC login (D5): later logins match `(iss, sub)` only; the first login of an active,
 * unbound account matched by its email binds the identity. A refusal found by the functions
 * (a concurrent binding, a deactivation) is recorded like one decided here.
 */
export async function loginWithOidc(
  c: Context<AppEnv>,
  deps: Deps,
  identity: OidcIdentity,
): Promise<LoginResult> {
  // The account a refusal from the functions refers to.
  const matched: { staffUserId: string | null } = { staffUserId: null };
  try {
    const result = await deps.db.transaction(async (tx) => {
      const bound = await tx.execute<StaffLoginAccount>(
        sql`select ${accountColumns} from staff_user
            where oidc_issuer = ${identity.issuer} and oidc_subject = ${identity.subject}`,
      );
      const byLoginName = identity.loginName
        ? await tx.execute<StaffLoginAccount>(
            sql`select ${accountColumns} from staff_user
                where lower(email) = lower(${identity.loginName.name})`,
          )
        : { rows: [] };
      const decision = staffLoginDecision({
        bound: bound.rows[0] ?? null,
        byLoginName: byLoginName.rows[0] ?? null,
      });
      if (decision.kind === "refuse") return decision;
      matched.staffUserId = decision.staffUserId;
      if (decision.kind === "bind") {
        await tx.execute(sql`select bind_staff_identity(
          p_staff_user_id => ${decision.staffUserId}::uuid, p_oidc_issuer => ${identity.issuer},
          p_oidc_subject => ${identity.subject}, p_matched_by => ${identity.loginName!.claim},
          p_request_id => ${c.get("requestId")}) as result`);
      }
      const expiresAt = await startSession(c, deps, tx, {
        staffUserId: decision.staffUserId,
        method: "oidc",
        identity: { issuer: identity.issuer, subject: identity.subject },
      });
      return { kind: "started" as const, expiresAt };
    });
    if (result.kind === "started") return { ok: true, expiresAt: result.expiresAt };
    return recordRefusal(c, deps, "oidc", result.code, result.staffUserId);
  } catch (error) {
    const code = refusalCode(error);
    if (!code) throw error;
    return recordRefusal(
      c,
      deps,
      "oidc",
      code,
      code === "unknown_account" ? null : matched.staffUserId,
    );
  }
}

/** A dev stub login (AUTH_MODE=dev) of an existing account, on the same store. */
export async function loginAsDevUser(
  c: Context<AppEnv>,
  deps: Deps,
  staffUserId: string,
): Promise<LoginResult> {
  try {
    const expiresAt = await startSession(c, deps, deps.db, {
      staffUserId,
      method: "dev",
      identity: null,
    });
    return { ok: true, expiresAt };
  } catch (error) {
    const code = refusalCode(error);
    if (!code) throw error;
    return recordRefusal(c, deps, "dev", code, code === "unknown_account" ? null : staffUserId);
  }
}
