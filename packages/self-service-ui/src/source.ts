import { ApiProblemError } from "@transfer/api-client";
import type {
  ConfidentialPage,
  NoticeLanguage,
  PortalSelfServiceWrite,
  PortalStepUp,
  SensitivePage,
  SensitiveValuesView,
} from "@transfer/domain";
import type { z } from "zod";
import type { Issue, WizardState } from "./model";

type PageInput = { revision: number; values: Record<string, unknown> };

/** A channel a step-up code can go to, masked as `GET /portal/channels` shows it. */
export type StepUpChannel = { id: string; kind: "email" | "sms"; maskedAddress: string };

/**
 * The participant's step-up before the special-category page (ADR-0007, step-up; Q137): the birth
 * date again, or a step-up code to a channel they pick. Staff in assisted mode need none.
 */
export interface StepUpSource {
  birthDate(birthDate: string): Promise<PortalStepUp>;
  channels(): Promise<StepUpChannel[]>;
  requestCode(channelId: string, language: NoticeLanguage): Promise<void>;
  verifyCode(oneTimeCode: string): Promise<PortalStepUp>;
}

/** The state after a write, with the warnings on what was saved. */
export type WizardWrite = WizardState & Pick<PortalSelfServiceWrite, "warnings">;

/**
 * Where the wizard reads and writes: the portal's own routes for the participant, the
 * assisted-mode routes for staff (ADR-0007, assisted mode). Each call throws the API client's
 * problem on refusal. A sensitive group is read and written on its own logged routes, never with
 * the wizard state.
 */
export interface SelfServiceSource {
  /** The query key of the wizard state (one per participant view). */
  queryKey: readonly unknown[];
  load(): Promise<WizardState>;
  acknowledge(language: NoticeLanguage): Promise<void>;
  save(page: ConfidentialPage, input: PageInput): Promise<WizardWrite>;
  loadSensitive(group: SensitivePage): Promise<{ values: z.infer<typeof SensitiveValuesView> }>;
  saveSensitive(group: SensitivePage, input: PageInput): Promise<WizardWrite>;
  /** Absent where no step-up applies: staff in assisted mode need none. */
  stepUp?: StepUpSource;
}

export type Failure =
  | { kind: "invalid"; issues: Issue[] }
  | { kind: "stale" }
  | { kind: "notice_required" }
  | { kind: "step_up_required" }
  | { kind: "expired" }
  | { kind: "closed" }
  | { kind: "failed" };

/**
 * What a refused request means for the wizard (ADR-0010 problems): `409 stale_revision` and
 * `notice_required` reload, `403 step_up_required` asks for the step-up, a `422` names codes at
 * `/values/...`, a `401` is an ended session.
 */
export function failureOf(error: unknown): Failure {
  if (!(error instanceof ApiProblemError)) return { kind: "failed" };
  const errors = error.problem.errors ?? [];
  if (error.status === 401) return { kind: "expired" };
  if (error.status === 403 && errors[0]?.code === "step_up_required") {
    return { kind: "step_up_required" };
  }
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
