import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  EntryPendingCode,
  correctionSourceMaxLength,
  normaliseCorrectionSource,
} from "@transfer/domain";
import {
  ActionButton,
  Card,
  formatDate,
  InlineNotification,
  Loading,
  Modal,
  Select,
  SelectItem,
  Stack,
  TextInput,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { entryClarificationQuery, tgEntryReconciliationQuery, useApi } from "../api";
import { ReconciliationDialog } from "./reconciliation";

// "Eintritt klären" on the tab "DSV" (process-and-lifecycle.md, the entry clarification; Q214, Q220
// open): a signed DSV that has not entered after its planned TG start. The PL documents what is
// pending (a code and one source line), escalates the note they saw to the regional operations
// manager, replies when the manager asks again, and sees the legitimate paths whose guards pass
// now. It changes no status; the case stays until the participation leaves `informed`, also when
// the planned start moved on. Every write names the revision read; every step is listed. Every
// button by its capability; the API checks each again. German only.

type State = components["schemas"]["EntryClarificationState"];
type Step = NonNullable<State["clarification"]>["steps"][number];

const codeOf = (error: unknown) =>
  error instanceof ApiProblemError ? error.problem.errors?.[0]?.code : undefined;

/** The latest step of a kind, or undefined. */
const latest = (steps: readonly Step[], kind: Step["kind"]) =>
  steps.findLast((step) => step.kind === kind);

export function EntryClarification({ participationId }: { participationId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const query = useQuery(entryClarificationQuery(api, participationId));
  // The reconciliation's own capability decides its button (process-and-lifecycle.md, the
  // reconciliation); the card names the path while its guards pass.
  const reconciliation = useQuery(tgEntryReconciliationQuery(api, participationId));
  const [reconciling, setReconciling] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string }>();
  const [code, setCode] = useState("");
  const [source, setSource] = useState("");
  const [shownInvalid, setShownInvalid] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: entryClarificationQuery(api, participationId).queryKey,
    });

  /** A refusal as the card's message: a stale read reloads the case. */
  function failure(error: unknown): string {
    if (error instanceof ApiProblemError && error.status === 409) {
      void refresh();
      return t("entryClarification.messages.conflict");
    }
    if (error instanceof ApiProblemError && error.status === 403) {
      return t("entryClarification.messages.forbidden");
    }
    const known = codeOf(error);
    const text = known && t(`entryClarification.codes.${known}` as never, { defaultValue: "" });
    if (known) void refresh();
    return text || t("entryClarification.messages.failed");
  }

  const write = useMutation({
    mutationFn: async (action: "record" | "escalate") => {
      const state = query.data!;
      const revision = state.clarification?.revision ?? 0;
      if (action === "record") {
        const { error } = await api.POST(
          "/api/v1/participations/{participationId}/entry-clarification",
          {
            params: { path: { participationId } },
            body: {
              code: code as components["schemas"]["EntryPendingCode"],
              source,
              statusVersion: state.statusVersion,
              revision,
            },
          },
        );
        if (error) throw error;
        return action;
      }
      const { error } = await api.POST(
        "/api/v1/participations/{participationId}/entry-clarification/escalation",
        {
          params: { path: { participationId } },
          body: { statusVersion: state.statusVersion, revision },
        },
      );
      if (error) throw error;
      return action;
    },
    onSuccess: async (action) => {
      setMessage({
        kind: "success",
        text: t(
          action === "record"
            ? "entryClarification.messages.recorded"
            : "entryClarification.messages.escalated",
        ),
      });
      if (action === "record") {
        setCode("");
        setSource("");
      }
      setShownInvalid(false);
      setConfirming(false);
      await refresh();
    },
    onError: (error) => {
      setConfirming(false);
      setMessage({ kind: "error", text: failure(error) });
    },
  });

  if (query.isPending) return <Loading label={t("entryClarification.loading")} />;
  if (query.isError) return <p role="alert">{t("entryClarification.failed")}</p>;
  const state: State = query.data;
  const { actions, clarification } = state;
  // The case exists from the day after the planned start, until the participation enters; an
  // unresolved one stays when the start moved on.
  if (!actions.open) return null;

  const steps = clarification?.steps ?? [];
  const note = latest(steps, "recorded");
  const request = latest(steps, "requested");
  const escalation = latest(steps, "escalated");
  const instruction = latest(steps, "instructed");
  const stage = clarification?.stage;
  const normalised = normaliseCorrectionSource(source);
  const sourceValid = normalised !== null && normalised.length <= correctionSourceMaxLength;
  const recordReason =
    code === ""
      ? t("entryClarification.pending.choose")
      : !sourceValid
        ? t("entryClarification.pending.enterSource")
        : null;
  const label = (prefix: string, value: string) =>
    t(`entryClarification.${prefix}.${value}` as never);
  const noPath = !actions.reconciliation && !actions.newStartDate;

  return (
    <Card title={t("entryClarification.title")} level={3} id="entry-clarification">
      <Stack gap={5}>
        <p>{t("entryClarification.intro", { date: formatDate(actions.openedOn!) })}</p>
        {message && (
          <InlineNotification
            kind={message.kind}
            role={message.kind === "error" ? "alert" : "status"}
            title={message.text}
            onClose={() => setMessage(undefined)}
            lowContrast
          />
        )}
        {stage === "returned" && request && (
          <InlineNotification
            kind="warning"
            hideCloseButton
            lowContrast
            title={t("entryClarification.returned.title")}
            subtitle={t("entryClarification.returned.body", {
              code: label("requestCodes", request.code),
              source: request.source,
              date: formatDate(request.on),
            })}
          />
        )}
        <section aria-labelledby="entry-paths">
          <h4 id="entry-paths">{t("entryClarification.paths.title")}</h4>
          <ul className="tp-list">
            {actions.reconciliation && (
              <li>
                {t("entryClarification.paths.reconciliation")}
                {reconciliation.data?.capabilities.reconcile && (
                  <div>
                    <ActionButton
                      size="md"
                      kind="secondary"
                      unavailableReason={null}
                      onClick={() => setReconciling(true)}
                    >
                      {t("entryClarification.paths.reconcile")}
                    </ActionButton>
                  </div>
                )}
              </li>
            )}
            {actions.newStartDate && <li>{t("entryClarification.paths.newStart")}</li>}
            {noPath && <li>{t("entryClarification.paths.none")}</li>}
          </ul>
        </section>
        <section aria-labelledby="entry-pending">
          <h4 id="entry-pending">{t("entryClarification.pending.title")}</h4>
          <Stack gap={4}>
            <p>
              {note
                ? t("entryClarification.pending.recorded", {
                    code: label("pendingCodes", note.code),
                    source: note.source,
                    date: formatDate(note.on),
                  })
                : t("entryClarification.pending.none")}
            </p>
            {actions.recordPending && state.capabilities.record && (
              <>
                <Select
                  id="entry-pending-code"
                  labelText={t(
                    stage === "returned"
                      ? "entryClarification.pending.replyCode"
                      : "entryClarification.pending.code",
                  )}
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                >
                  <SelectItem value="" text="" />
                  {EntryPendingCode.options.map((option) => (
                    <SelectItem key={option} value={option} text={label("pendingCodes", option)} />
                  ))}
                </Select>
                <TextInput
                  id="entry-pending-source"
                  labelText={t("entryClarification.pending.source")}
                  value={source}
                  maxLength={correctionSourceMaxLength}
                  onChange={(event) => {
                    setSource(event.target.value);
                    setShownInvalid(false);
                  }}
                  invalid={shownInvalid && !sourceValid}
                  invalidText={t("entryClarification.pending.sourceInvalid")}
                />
                <div>
                  <ActionButton
                    size="md"
                    disabled={write.isPending}
                    unavailableReason={recordReason}
                    onClick={() => {
                      if (!sourceValid) setShownInvalid(true);
                      else write.mutate("record");
                    }}
                  >
                    {t(
                      stage === "returned"
                        ? "entryClarification.pending.reply"
                        : "entryClarification.pending.save",
                    )}
                  </ActionButton>
                </div>
              </>
            )}
          </Stack>
        </section>
        <section aria-labelledby="entry-escalation">
          <h4 id="entry-escalation">{t("entryClarification.escalation.title")}</h4>
          <Stack gap={4}>
            <p>
              {stage === "escalated" || stage === "instructed"
                ? t("entryClarification.escalation.done", {
                    date: formatDate(escalation!.on),
                  })
                : t("entryClarification.escalation.not")}
            </p>
            {state.capabilities.escalate && actions.escalate ? (
              <div>
                <ActionButton
                  size="md"
                  disabled={write.isPending}
                  unavailableReason={null}
                  onClick={() => setConfirming(true)}
                >
                  {t("entryClarification.escalation.button")}
                </ActionButton>
              </div>
            ) : (
              (stage === undefined || stage === "returned") &&
              state.capabilities.record && (
                <p className="tp-hint">{t("entryClarification.escalation.needsPending")}</p>
              )
            )}
          </Stack>
        </section>
        {stage === "escalated" && (
          <section aria-labelledby="entry-instruction">
            <h4 id="entry-instruction">{t("entryClarification.instruction.title")}</h4>
            <p>{t("entryClarification.instruction.waiting")}</p>
          </section>
        )}
        {stage === "instructed" && instruction && (
          <section aria-labelledby="entry-instruction">
            <h4 id="entry-instruction">{t("entryClarification.instruction.title")}</h4>
            <p>
              {t("entryClarification.instruction.recorded", {
                code: label("instructionCodes", instruction.code),
                source: instruction.source,
                date: formatDate(instruction.on),
              })}
            </p>
          </section>
        )}
        {steps.length > 0 && (
          <section aria-labelledby="entry-history">
            <h4 id="entry-history">{t("entryClarification.history.title")}</h4>
            <ol className="tp-list" data-testid="entry-clarification-history">
              {steps.map((step, index) => (
                <li key={index}>
                  {t("entryClarification.history.step", {
                    date: formatDate(step.on),
                    kind: t(`entryClarification.history.kinds.${step.kind}`),
                    code: label(
                      step.kind === "requested"
                        ? "requestCodes"
                        : step.kind === "instructed"
                          ? "instructionCodes"
                          : "pendingCodes",
                      step.code,
                    ),
                    source: step.source,
                  })}
                </li>
              ))}
            </ol>
          </section>
        )}
      </Stack>
      {reconciling && (
        <ReconciliationDialog
          participationId={participationId}
          onClose={() => setReconciling(false)}
        />
      )}
      <Modal
        open={confirming}
        size="sm"
        modalHeading={t("entryClarification.escalation.dialogTitle")}
        primaryButtonText={t("entryClarification.escalation.confirm")}
        secondaryButtonText={t("entryClarification.escalation.cancel")}
        primaryButtonDisabled={write.isPending}
        onRequestClose={() => setConfirming(false)}
        onRequestSubmit={() => write.mutate("escalate")}
      >
        <Stack gap={3}>
          <p>{t("entryClarification.escalation.dialogBody")}</p>
          {note && (
            <p>
              {t("entryClarification.pending.recorded", {
                code: label("pendingCodes", note.code),
                source: note.source,
                date: formatDate(note.on),
              })}
            </p>
          )}
        </Stack>
      </Modal>
    </Card>
  );
}
