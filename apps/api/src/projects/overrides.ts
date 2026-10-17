import {
  validateProjectOverride,
  withAgenturSetting,
  withRelaxation,
  type ProjectOverride,
} from "@transfer/config";
import {
  configRelaxationRequest as relaxationRequest,
  eq,
  project,
  sql,
  type Database,
} from "@transfer/db";
import type {
  DecideRelaxationInput,
  OverrideChange,
  RequestRelaxationInput,
  TemporaryAgenturSetting,
} from "@transfer/domain";
import { functionRefusal } from "../database-errors";
import { auditContext, callFunction } from "../sql";
import {
  currentOverride,
  currentPins,
  overrideIssues,
  templatesOf,
  type Release,
} from "./template-pins";

/** A write's outcome: done, a problem type (404/403/409), or domain issues (422), per R21. */
export type OverrideOutcome<P extends string = "not-found" | "conflict"> =
  | { ok: true }
  | { problem: P }
  | { issues: readonly string[] };

/** Who writes with which release: the acting staff user and the request id for the audit. */
export type Writer = {
  db: Database;
  release: Release;
  actor: { staffUserId: string; requestId: string | null };
};
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Refusals<P extends string> = Readonly<Record<string, OverrideOutcome<P>>>;

const issue = (code: string) => ({ issues: [code] });
const contextOf = ({ actor }: Writer) => auditContext(actor.staffUserId, actor.requestId);

// The function refusals each operation allowlists (R21, round 23); anything else is a 500.
const overrideRefusals: Refusals<"not-found" | "conflict"> = {
  project_not_found: { problem: "not-found" },
  override_version_stale: { problem: "conflict" },
  override_unchanged: issue("override_unchanged"),
};
const requestRefusals: Refusals<"not-found"> = {
  project_not_found: { problem: "not-found" },
  relaxation_request_open: issue("relaxation_request_open"),
  relaxation_exists: issue("relaxation_exists"),
};
const withdrawalRefusals: Refusals<"not-found"> = {
  request_not_found: { problem: "not-found" },
  relaxation_not_open: issue("relaxation_not_open"),
};
const decisionRefusals: Refusals<"not-found" | "conflict" | "forbidden"> = {
  ...withdrawalRefusals,
  override_version_stale: { problem: "conflict" },
  // The route checks four eyes first (R2); this is the function's own check.
  same_person_approval: { problem: "forbidden" },
};

/**
 * Runs `write` in one transaction under the exclusive project lock (D3), mapping refusals. The
 * project is given, or read from a relaxation request (none: a 404).
 */
function underLock<P extends string>(
  db: Database,
  projectId: string | { requestId: string },
  refusals: Refusals<P>,
  write: (tx: Tx, projectId: string) => Promise<OverrideOutcome<P>>,
): Promise<OverrideOutcome<P | "not-found">> {
  return db
    .transaction(async (tx): Promise<OverrideOutcome<P | "not-found">> => {
      const id =
        typeof projectId === "string"
          ? projectId
          : (await relaxationRequestOf(tx, projectId.requestId))?.projectId;
      if (id === undefined) return { problem: "not-found" };
      // The functions take the lock again (re-entrant).
      await tx.execute(sql`select lock_project_setup(${id}::uuid)`);
      return write(tx, id);
    })
    .catch((error: unknown) => {
      const outcome = refusals[functionRefusal(error) ?? ""];
      if (outcome) return outcome;
      throw error;
    });
}

/**
 * The next override content, validated against the base-only chain and every pinned chain
 * (`validateProjectOverride`, R16), read under the lock; `issues` when it would be invalid.
 */
async function nextOverride(
  tx: Tx,
  release: Release,
  projectId: string,
  next: ProjectOverride,
): Promise<{ content: string } | { issues: readonly string[] }> {
  const [found] = await tx
    .select({ type: project.type })
    .from(project)
    .where(eq(project.id, projectId));
  const validation = validateProjectOverride({
    base: release.baseDefaults,
    templatesByAgentur: templatesOf(await currentPins(tx, projectId)),
    override: next,
    projectType: found!.type,
  });
  return validation.ok ? { content: JSON.stringify(next) } : { issues: overrideIssues(validation) };
}

/** The relaxation an approval by the writer on `today` adds (5.9 step 3). */
const approvedBy = (w: Writer, input: { ruleId: string; reasonCode: string }, today: string) => ({
  ruleId: input.ruleId,
  reasonCode: input.reasonCode,
  approvedBy: w.actor.staffUserId,
  approvedOn: today,
});

/**
 * A new override version that changes one Agentur's scoped setting or removes one approved
 * relaxation (plan 5.9): compares the expected version (409 when stale), builds the content
 * (`null`: nothing to remove, a 404), validates it, then `write_project_override`.
 */
function writeOverride(
  w: Writer,
  projectId: string,
  expectedVersion: number,
  change: { kind: OverrideChange; agenturKey?: string; ruleId?: string },
  build: (current: ProjectOverride | undefined) => ProjectOverride | null,
): Promise<OverrideOutcome> {
  return underLock<"not-found" | "conflict">(w.db, projectId, overrideRefusals, async (tx) => {
    const current = await currentOverride(tx, projectId);
    if (current.version !== expectedVersion) return { problem: "conflict" };
    const content = build(current.content);
    if (!content) return { problem: "not-found" };
    const next = await nextOverride(tx, w.release, projectId, content);
    if ("issues" in next) return next;
    await callFunction(
      tx,
      sql`write_project_override(p_project_id => ${projectId}::uuid,
        p_expected_version => ${expectedVersion}::integer, p_content => ${next.content}::jsonb,
        p_change => ${change.kind}, p_agentur_key => ${change.agenturKey ?? null},
        p_rule_id => ${change.ruleId ?? null},
        p_base_defaults_version => ${w.release.baseDefaults.version}::integer,
        p_context => ${contextOf(w)})`,
    );
    return { ok: true };
  });
}

/**
 * Sets (`setting`) or removes (`null`) an Agentur's scoped setting (plan 5.9, round 8, Q93) as a
 * new override version; removing one the override doesn't have is a 404. The setting's rules
 * (R14) are the route's, with the injected `Clock`.
 */
export function changeAgenturSetting(
  w: Writer,
  projectId: string,
  agenturKey: string,
  change: { expectedVersion: number; setting: TemporaryAgenturSetting | null },
): Promise<OverrideOutcome> {
  const kind = change.setting ? "agentur_setting_set" : "agentur_setting_removed";
  return writeOverride(w, projectId, change.expectedVersion, { kind, agenturKey }, (current) =>
    change.setting || Object.hasOwn(current?.agenturSettings ?? {}, agenturKey)
      ? withAgenturSetting(current, agenturKey, change.setting)
      : null,
  );
}

/** Removes an approved relaxation (5.9 step 4: tightening, no approval); none is a 404. */
export function removeRelaxation(
  w: Writer,
  projectId: string,
  ruleId: string,
  expectedVersion: number,
): Promise<OverrideOutcome> {
  const change = { kind: "relaxation_removed", ruleId } as const;
  return writeOverride(w, projectId, expectedVersion, change, (current) =>
    current?.relax?.some((relaxation) => relaxation.ruleId === ruleId)
      ? withRelaxation(current, { ruleId, relaxation: null })
      : null,
  );
}

/** A relaxation request's project, requester, rule and status (the route's access checks). */
export async function relaxationRequestOf(db: Pick<Database, "select">, requestId: string) {
  const [found] = await db
    .select({
      projectId: relaxationRequest.projectId,
      requestedBy: relaxationRequest.requestedBy,
      ruleId: relaxationRequest.ruleId,
      reasonCode: relaxationRequest.reasonCode,
      status: relaxationRequest.status,
    })
    .from(relaxationRequest)
    .where(eq(relaxationRequest.id, requestId));
  return found;
}

/**
 * The PL asks to relax a rule (5.9 steps 1–2): checked against the current snapshot as the
 * override it would make once approved, so the rule must exist in some chain and be
 * `operational_default` (`relaxation_unmatched`, `relaxation_locked`), then
 * `request_rule_relaxation` (one open request per rule; not relaxed already).
 */
export function requestRelaxation(
  w: Writer,
  projectId: string,
  input: RequestRelaxationInput,
  today: string,
): Promise<OverrideOutcome<"not-found">> {
  return underLock(w.db, projectId, requestRefusals, async (tx) => {
    const { content } = await currentOverride(tx, projectId);
    const { ruleId, reasonCode } = input;
    if (content?.relax?.some((relaxation) => relaxation.ruleId === ruleId)) {
      return issue("relaxation_exists");
    }
    const relaxation = approvedBy(w, input, today);
    const next = await nextOverride(
      tx,
      w.release,
      projectId,
      withRelaxation(content, { ruleId, relaxation }),
    );
    if ("issues" in next) return next;
    await callFunction(
      tx,
      sql`request_rule_relaxation(p_project_id => ${projectId}::uuid, p_rule_id => ${ruleId},
        p_reason_code => ${reasonCode}::relaxation_reason_code, p_requested_on => ${today}::date,
        p_base_defaults_version => ${w.release.baseDefaults.version}::integer,
        p_context => ${contextOf(w)})`,
    );
    return { ok: true };
  });
}

/**
 * Another person decides a pending request (5.9 step 3, R2; the route checked four eyes). An
 * approval compares the expected override version (409), builds the next override with the
 * relaxation and validates it against the current snapshot again (AC-16), then
 * `decide_rule_relaxation` writes the decision and that version in one transaction.
 */
export function decideRelaxation(
  w: Writer,
  requestId: string,
  input: DecideRelaxationInput,
  today: string,
): Promise<OverrideOutcome<"not-found" | "conflict" | "forbidden">> {
  const decision = sql`p_request_id => ${requestId}::uuid, p_decided_on => ${today}::date,
    p_context => ${contextOf(w)}`;
  return underLock<"not-found" | "conflict" | "forbidden">(
    w.db,
    { requestId },
    decisionRefusals,
    async (tx, projectId) => {
      if (input.decision === "rejected") {
        await callFunction(tx, sql`decide_rule_relaxation(${decision}, p_approve => false)`);
        return { ok: true };
      }
      const request = (await relaxationRequestOf(tx, requestId))!;
      if (request.status !== "requested") return issue("relaxation_not_open");
      const current = await currentOverride(tx, projectId);
      if (current.version !== input.expectedVersion) return { problem: "conflict" };
      const relaxation = approvedBy(w, request, today);
      const content = withRelaxation(current.content, { ruleId: request.ruleId, relaxation });
      const next = await nextOverride(tx, w.release, projectId, content);
      if ("issues" in next) return next;
      await callFunction(
        tx,
        sql`decide_rule_relaxation(${decision}, p_approve => true,
          p_expected_version => ${input.expectedVersion}::integer,
          p_content => ${next.content}::jsonb,
          p_base_defaults_version => ${w.release.baseDefaults.version}::integer)`,
      );
      return { ok: true };
    },
  );
}

/** The PL withdraws a pending request (5.9 step 4); nothing in the configuration changes. */
export function withdrawRelaxation(
  w: Writer,
  requestId: string,
): Promise<OverrideOutcome<"not-found">> {
  return underLock(w.db, { requestId }, withdrawalRefusals, async (tx) => {
    await callFunction(
      tx,
      sql`withdraw_rule_relaxation(p_request_id => ${requestId}::uuid, p_context => ${contextOf(w)})`,
    );
    return { ok: true };
  });
}
