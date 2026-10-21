import { ApiProblemError } from "@transfer/api-client";
import type {
  ConfidentialPage,
  NoticeLanguage,
  PortalSelfService,
  PortalSelfServiceWrite,
} from "@transfer/domain";
import type { Issue } from "./model";

/**
 * Where the wizard reads and writes: the portal's own routes for the participant, later the
 * assisted-mode routes for staff (ADR-0007). Each call throws the API client's problem on refusal.
 */
export interface SelfServiceSource {
  /** The query key of the wizard state (one per participant view). */
  queryKey: readonly unknown[];
  load(): Promise<PortalSelfService>;
  acknowledge(language: NoticeLanguage): Promise<void>;
  save(
    page: ConfidentialPage,
    input: { revision: number; values: Record<string, unknown> },
  ): Promise<PortalSelfServiceWrite>;
}

export type Failure =
  | { kind: "invalid"; issues: Issue[] }
  | { kind: "stale" }
  | { kind: "notice_required" }
  | { kind: "expired" }
  | { kind: "closed" }
  | { kind: "failed" };

/**
 * What a refused request means for the wizard (ADR-0010 problems): `409 stale_revision` and
 * `notice_required` reload, a `422` names codes at `/values/...`, a `401` is an ended session.
 */
export function failureOf(error: unknown): Failure {
  if (!(error instanceof ApiProblemError)) return { kind: "failed" };
  const errors = error.problem.errors ?? [];
  if (error.status === 401) return { kind: "expired" };
  if (error.status === 409) {
    const code = errors[0]?.code;
    if (code === "stale_revision") return { kind: "stale" };
    if (code === "notice_required") return { kind: "notice_required" };
  }
  if (error.status === 422) {
    if (errors.some((item) => item.code === "participation_closed")) return { kind: "closed" };
    return {
      kind: "invalid",
      issues: errors.map((item) => ({
        path: (item.pointer ?? "").replace(/^\/values\/?/, ""),
        code: item.code,
      })),
    };
  }
  return { kind: "failed" };
}
