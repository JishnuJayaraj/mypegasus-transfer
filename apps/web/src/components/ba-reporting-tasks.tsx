import { useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  Button,
  DateField,
  formatDate,
  formatTimestamp,
  InlineNotification,
  Modal,
  parseDisplayDate,
  Select,
  SelectItem,
  SimpleTable,
  Stack,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { participationQuery, useApi, worklistQuery } from "../api";
import { useCorrectionRequest } from "./evidence-correction";

// "BA-Meldungen" on the overview (process-and-lifecycle.md, BA reporting; D28): every reporting
// task with its outcome; for a pending one, the PL or back office records "Gemeldet am" with the
// actual sent date or "Nicht erforderlich" with its reason, each confirmed in a dialog that names
// the task. Nothing is filled in on the user's behalf: no default date, no default reason. The
// buttons follow the API's capability; an outcome is never edited here: "Korrektur beantragen"
// asks for an approved correction that supersedes it by a linked replacement task (Q190,
// Q207 (6)). The dialog captures the task it opened for, so a dialog still open for a superseded
// task never closes its replacement. Every write sends a JSON body; the detail and the work list
// are read again afterwards.

type Detail = components["schemas"]["ParticipationDetail"];
type Task = components["schemas"]["BaReportingTask"];
type Input = components["schemas"]["BaReportInput"];
type Reason = Extract<Input, { outcome: "not_required" }>["reason"];
type Dialog = { kind: "reported" | "not_required"; task: Task } | { kind: "none" };

const reasons = [
  "agentur_confirmed_not_required",
  "no_claim_month_affected",
  "created_in_error",
] as const satisfies Reason[];

/** A refusal's message key: its first code's where there is one. */
function messageOf(error: unknown): string {
  if (!(error instanceof ApiProblemError)) return "failed";
  if (error.status === 403) return "forbidden";
  if (error.status === 404) return "notFound";
  const code = error.problem.errors?.[0]?.code;
  return error.status === 422 && code ? `codes.${code}` : "failed";
}

export function BaReportingTasks({ detail }: { detail: Detail }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string }>();
  const [busy, setBusy] = useState(false);
  const correction = useCorrectionRequest({
    participationId: detail.id,
    projectId: detail.projectId,
  });
  if (detail.baReportingTasks === undefined) return null;
  const tasks = detail.baReportingTasks;

  /** Records an outcome; the detail and the work list are read again whatever happened. */
  async function record(task: Task, body: Input) {
    setBusy(true);
    setMessage(undefined);
    try {
      await api.POST("/api/v1/ba-reporting-tasks/{taskId}/outcome", {
        params: { path: { taskId: task.id } },
        body,
      });
      setMessage({ kind: "success", text: t("participant.tasks.messages.saved") });
      setDialog({ kind: "none" });
    } catch (error) {
      setMessage({
        kind: "error",
        text: t(`participant.tasks.messages.${messageOf(error)}` as never, {
          defaultValue: t("participant.tasks.messages.failed"),
        }),
      });
      setDialog({ kind: "none" });
    } finally {
      setBusy(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: participationQuery(api, detail.id).queryKey }),
        queryClient.invalidateQueries({ queryKey: worklistQuery(api, detail.projectId).queryKey }),
      ]);
    }
  }

  const outcomeOf = (task: Task) =>
    task.status === "reported" && task.reportedOn
      ? t("participant.tasks.reportedOn", { date: formatDate(task.reportedOn) })
      : task.status === "not_required" && task.notRequiredReason
        ? t("participant.tasks.notRequired", {
            reason: t(`participant.tasks.reasons.${task.notRequiredReason}`),
          })
        : "—";
  const anyAction = tasks.some(
    (task) => task.capabilities.recordOutcome || task.correction.mayRequest,
  );
  const statusOf = (task: Task) =>
    [
      t(`participant.tasks.statuses.${task.status}`),
      ...(task.supersededBy !== null ? [t("participant.tasks.superseded")] : []),
      ...(task.replacesTaskId !== null ? [t("participant.tasks.replacement")] : []),
      ...(task.correction.pending ? [t("corrections.pending")] : []),
    ].join(" · ");
  const columns = [
    "reportingKind",
    "subjectDate",
    "createdAt",
    "status",
    "outcome",
    ...(anyAction ? (["actions"] as const) : []),
  ] as const;
  return (
    <section className="tp-section" aria-labelledby="ba-reporting-tasks">
      <Stack gap={5}>
        <h2 id="ba-reporting-tasks">{t("participant.tasks.title")}</h2>
        {correction.element}
        <p>{t("participant.tasks.intro")}</p>
        {message && (
          <InlineNotification
            kind={message.kind}
            role={message.kind === "error" ? "alert" : "status"}
            title={message.text}
            onClose={() => setMessage(undefined)}
            lowContrast
          />
        )}
        <SimpleTable
          title={t("participant.tasks.listTitle")}
          columns={columns.map((key) => ({ key, header: t(`participant.tasks.columns.${key}`) }))}
          rows={tasks.map((task) => ({
            id: task.id,
            reportingKind: t(`participant.tasks.kinds.${task.reportingKind}`),
            subjectDate: formatDate(task.subjectDate),
            createdAt: formatTimestamp(task.createdAt),
            status: statusOf(task),
            outcome: outcomeOf(task),
            actions: task.capabilities.recordOutcome ? (
              <>
                <Button
                  kind="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setDialog({ kind: "reported", task })}
                >
                  {t("participant.tasks.recordReported")}
                </Button>
                <Button
                  kind="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => setDialog({ kind: "not_required", task })}
                >
                  {t("participant.tasks.recordNotRequired")}
                </Button>
              </>
            ) : task.correction.mayRequest ? (
              correction.button({
                kind: "ba_reporting_task",
                id: task.id,
                label: t("participant.tasks.dialog.task", {
                  kind: t(`participant.tasks.kinds.${task.reportingKind}`),
                  date: formatDate(task.subjectDate),
                }),
              })
            ) : null,
          }))}
          emptyState={t("participant.tasks.empty")}
        />
      </Stack>
      <OutcomeDialog
        // A new dialog starts empty: never another task's date or reason.
        key={dialog.kind === "none" ? "none" : `${dialog.kind}-${dialog.task.id}`}
        dialog={dialog}
        busy={busy}
        onClose={() => setDialog({ kind: "none" })}
        onReported={(task, reportedOn) => record(task, { outcome: "reported", reportedOn })}
        onNotRequired={(task, reason) => record(task, { outcome: "not_required", reason })}
      />
    </section>
  );
}

/** The confirmation of one outcome: the task it closes, the date or the reason, then confirm. */
function OutcomeDialog(props: {
  dialog: Dialog;
  busy: boolean;
  onClose: () => void;
  onReported: (task: Task, reportedOn: string) => Promise<void>;
  onNotRequired: (task: Task, reason: Reason) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [date, setDate] = useState("");
  const [reason, setReason] = useState<Reason | "">("");
  const [invalid, setInvalid] = useState(false);
  const { dialog } = props;
  const kind = dialog.kind === "none" ? undefined : dialog.kind;
  const submit = async () => {
    if (dialog.kind === "none") return;
    if (dialog.kind === "not_required") {
      if (reason !== "") await props.onNotRequired(dialog.task, reason);
      return;
    }
    const parsed = parseDisplayDate(date);
    if (!parsed.ok || parsed.value === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    await props.onReported(dialog.task, parsed.value);
  };
  return (
    <Modal
      open={kind !== undefined}
      size="sm"
      modalHeading={kind ? t(`participant.tasks.dialog.${kind}Title`) : ""}
      primaryButtonText={t("participant.tasks.dialog.confirm")}
      secondaryButtonText={t("participant.tasks.dialog.cancel")}
      primaryButtonDisabled={
        props.busy || (kind === "reported" ? date === "" : kind === "not_required" && reason === "")
      }
      onRequestClose={props.onClose}
      onRequestSubmit={() => void submit()}
    >
      {dialog.kind !== "none" && (
        <Stack gap={5}>
          <p>
            {t("participant.tasks.dialog.task", {
              kind: t(`participant.tasks.kinds.${dialog.task.reportingKind}`),
              date: formatDate(dialog.task.subjectDate),
            })}
          </p>
          {dialog.kind === "reported" && <p>{t("participant.tasks.dialog.reportedOnHelp")}</p>}
          {dialog.kind === "reported" ? (
            <DateField
              id="ba-report-reported-on"
              labelText={t("participant.tasks.dialog.reportedOn")}
              defaultValue={date}
              onChange={setDate}
              invalidText={invalid ? t("participant.tasks.dialog.invalidDate") : undefined}
            />
          ) : (
            <Select
              id="ba-report-reason"
              labelText={t("participant.tasks.dialog.reason")}
              value={reason}
              onChange={(event) => setReason(event.target.value as Reason | "")}
            >
              <SelectItem value="" text={t("participant.tasks.dialog.chooseReason")} />
              {reasons.map((option) => (
                <SelectItem
                  key={option}
                  value={option}
                  text={t(`participant.tasks.reasons.${option}`)}
                />
              ))}
            </Select>
          )}
          <p>{t("participant.tasks.dialog.final")}</p>
        </Stack>
      )}
    </Modal>
  );
}
