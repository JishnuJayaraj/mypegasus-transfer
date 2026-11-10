import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  EntryInstructionCode,
  EntryRequestCode,
  ReconciliationReasonCode,
  correctionSourceMaxLength,
  normaliseCorrectionSource,
} from "@transfer/domain";
import {
  Button,
  formatDate,
  InlineNotification,
  Loading,
  Modal,
  PageHeader,
  Select,
  SelectItem,
  SimpleTable,
  Stack,
  TextInput,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { reviewsQuery, useApi } from "../api";
import { RouteError } from "../components/route-error";
import { reconciliationStepText } from "../components/reconciliation";
import { SELF_SERVICE_NAMESPACE } from "@transfer/self-service-ui";
import { usePageTitle } from "../page-title";

export const Route = createFileRoute("/reviews")({
  component: ReviewsPage,
  errorComponent: RouteError,
});

type Item = components["schemas"]["ReviewQueue"]["items"][number];
type Correction = components["schemas"]["ReviewQueue"]["corrections"][number];
type Decision = "approve" | "reject";

/** A refusal's message key: its first code's where there is one. */
function messageOf(error: unknown): string {
  if (!(error instanceof ApiProblemError)) return "failed";
  if (error.status === 403) return "forbidden";
  if (error.status === 404) return "notFound";
  const code = error.problem.errors?.[0]?.code;
  return (error.status === 422 || error.status === 409) && code ? `codes.${code}` : "failed";
}

/**
 * "Freigaben" (process-and-lifecycle.md, profiling exceptions; Q80, Q194): for the regional
 * operations manager the pending profiling exceptions of their regions' projects, oldest first,
 * with the project, the reason code, the dates, the evidence's kind and whether it is present;
 * never a name, case data or the evidence itself. "Genehmigen" and "Ablehnen" are confirmed in a
 * dialog naming the request, and send the evidence record shown here; never on one's own request.
 * Below, the pending evidence corrections (data-protection.md, evidence corrections): the target's
 * kind and category, the action, the reason, the documented source and the dates, never a value
 * the manager couldn't otherwise read; "Freigeben" and "Zurückweisen" are confirmed in a dialog
 * that captures the correction it opened for.
 */
function ReviewsPage() {
  const { t } = useTranslation();
  usePageTitle(t("reviews.title"));
  const api = useApi();
  const queryClient = useQueryClient();
  const query = useQuery(reviewsQuery(api));
  const [dialog, setDialog] = useState<{ item: Item; decision: Decision }>();
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string }>();
  const [busy, setBusy] = useState(false);
  if (query.error instanceof ApiProblemError && query.error.status === 403) {
    return <p role="alert">{t("reviews.forbidden")}</p>;
  }
  if (query.isError) return <p role="alert">{t("reviews.failed")}</p>;
  if (!query.data) return <Loading label={t("reviews.loading")} />;

  async function decide(item: Item, decision: Decision) {
    setBusy(true);
    setMessage(undefined);
    try {
      const { error } = await api.POST(
        "/api/v1/profiling-exception-requests/{requestId}/decision",
        {
          params: { path: { requestId: item.requestId } },
          body: { decision, evidenceRecordId: item.evidenceRecordId },
        },
      );
      if (error) throw error;
      setMessage({
        kind: "success",
        text: t(decision === "approve" ? "reviews.messages.approved" : "reviews.messages.rejected"),
      });
    } catch (error) {
      setMessage({
        kind: "error",
        text: t(`reviews.messages.${messageOf(error)}` as never, {
          defaultValue: t("reviews.messages.failed"),
        }),
      });
    } finally {
      setBusy(false);
      setDialog(undefined);
      await queryClient.invalidateQueries({ queryKey: reviewsQuery(api).queryKey });
    }
  }

  const label = (item: Item) =>
    t("reviews.item", {
      project: item.projectName,
      reason: t(`history.reasons.${item.reason}`),
      date: formatDate(item.requestedOn),
    });
  const { items, corrections, clarifications, reconciliations } = query.data;
  return (
    <>
      <PageHeader title={t("reviews.title")} />
      <Stack gap={5}>
        <p>{t("reviews.intro")}</p>
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
          title={t("reviews.listTitle")}
          columns={(
            ["project", "reason", "requestedOn", "tgStart", "evidence", "actions"] as const
          ).map((key) => ({ key, header: t(`reviews.columns.${key}`) }))}
          rows={items.map((item) => ({
            id: item.requestId,
            project: item.projectName,
            reason: t(`history.reasons.${item.reason}`),
            requestedOn: formatDate(item.requestedOn),
            tgStart: item.tgStart ? formatDate(item.tgStart) : "–",
            evidence: t(
              item.evidencePresent ? "reviews.evidencePresent" : "reviews.evidenceMissing",
              {
                kind: t(`profiling.exception.kinds.${item.evidenceKind}`),
              },
            ),
            actions: item.capabilities.decide ? (
              <>
                <Button
                  kind="ghost"
                  size="sm"
                  disabled={busy || !item.evidencePresent}
                  aria-label={`${t("reviews.approve")}: ${label(item)}`}
                  onClick={() => setDialog({ item, decision: "approve" })}
                >
                  {t("reviews.approve")}
                </Button>
                <Button
                  kind="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={`${t("reviews.reject")}: ${label(item)}`}
                  onClick={() => setDialog({ item, decision: "reject" })}
                >
                  {t("reviews.reject")}
                </Button>
              </>
            ) : (
              t("reviews.ownRequest")
            ),
          }))}
          emptyState={t("reviews.empty")}
        />
        <CorrectionQueue
          corrections={corrections}
          onDecided={async (result) => {
            setMessage(result);
            await queryClient.invalidateQueries({ queryKey: reviewsQuery(api).queryKey });
          }}
        />
        <ClarificationQueue
          clarifications={clarifications}
          onDecided={async (result) => {
            setMessage(result);
            await queryClient.invalidateQueries({ queryKey: reviewsQuery(api).queryKey });
          }}
        />
        <ReconciliationQueue
          reconciliations={reconciliations}
          onDecided={async (result) => {
            setMessage(result);
            await queryClient.invalidateQueries({ queryKey: reviewsQuery(api).queryKey });
          }}
        />
      </Stack>
      <Modal
        open={dialog !== undefined}
        size="sm"
        danger={dialog?.decision === "reject"}
        modalHeading={dialog ? t(`reviews.dialog.${dialog.decision}Title`) : ""}
        primaryButtonText={dialog ? t(`reviews.dialog.${dialog.decision}Confirm`) : ""}
        secondaryButtonText={t("reviews.dialog.cancel")}
        primaryButtonDisabled={busy}
        onRequestClose={() => setDialog(undefined)}
        onRequestSubmit={() => dialog && void decide(dialog.item, dialog.decision)}
      >
        {dialog && (
          <Stack gap={3}>
            <p>{label(dialog.item)}</p>
            <p>
              {t("reviews.dialog.evidence", {
                kind: t(`profiling.exception.kinds.${dialog.item.evidenceKind}`),
              })}
            </p>
            <p>{t("reviews.dialog.final")}</p>
          </Stack>
        )}
      </Modal>
    </>
  );
}

/** The target of a correction as the queue names it: its kind and category, never a value. */
function useTargetLabel() {
  const { t } = useTranslation();
  const { t: ts } = useTranslation(SELF_SERVICE_NAMESPACE);
  return (item: Correction) => {
    const category =
      item.documentType !== null
        ? ts(`documents.types.${item.documentType}`)
        : item.reportingKind !== null
          ? t(`participant.tasks.kinds.${item.reportingKind}`)
          : "";
    const kind = t(`corrections.targets.${item.targetKind}`);
    return category ? `${kind}: ${category}` : kind;
  };
}

/** The pending corrections and their decision (four eyes; the API checks it again). */
function CorrectionQueue(props: {
  corrections: Correction[];
  onDecided: (message: { kind: "success" | "error"; text: string }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const target = useTargetLabel();
  const [dialog, setDialog] = useState<{ item: Correction; decision: Decision }>();
  const [busy, setBusy] = useState(false);
  const label = (item: Correction) =>
    t("reviews.corrections.item", {
      project: item.projectName,
      target: target(item),
      date: formatDate(item.requestedOn),
    });
  const action = (item: Correction) =>
    item.wrongPerson
      ? `${t(`corrections.actions.${item.action}`)} (${t("reviews.corrections.wrongPerson")})`
      : t(`corrections.actions.${item.action}`);
  const effect = (item: Correction) =>
    item.targetKind === "document"
      ? item.wrongPerson
        ? "invalidate_document_wrong_person"
        : "invalidate_document"
      : `${item.action}_${item.targetKind}`;

  async function decide(item: Correction, decision: Decision) {
    setBusy(true);
    let result: { kind: "success" | "error"; text: string };
    try {
      await api.POST("/api/v1/evidence-corrections/{correctionId}/decision", {
        params: { path: { correctionId: item.correctionId } },
        body: { decision },
      });
      result = {
        kind: "success",
        text: t(`reviews.corrections.messages.${decision === "approve" ? "approved" : "rejected"}`),
      };
    } catch (error) {
      const key = messageOf(error);
      result = {
        kind: "error",
        text: t(`reviews.corrections.messages.${key}` as never, {
          defaultValue: t(`reviews.messages.${key}` as never, {
            defaultValue: t("reviews.messages.failed"),
          }),
        }),
      };
    } finally {
      setBusy(false);
      setDialog(undefined);
    }
    await props.onDecided(result);
  }

  return (
    <>
      <SimpleTable
        title={t("reviews.corrections.listTitle")}
        columns={(
          [
            "project",
            "target",
            "action",
            "reason",
            "source",
            "requestedOn",
            "recordedOn",
            "actions",
          ] as const
        ).map((key) => ({ key, header: t(`reviews.corrections.columns.${key}`) }))}
        rows={props.corrections.map((item) => ({
          id: item.correctionId,
          project: item.projectName,
          target: target(item),
          action: action(item),
          reason: t(`corrections.reasons.${item.reason}`),
          source: item.source,
          requestedOn: formatDate(item.requestedOn),
          recordedOn: formatDate(item.targetRecordedOn),
          actions: item.capabilities.decide ? (
            <>
              <Button
                kind="ghost"
                size="sm"
                disabled={busy}
                aria-label={`${t("reviews.corrections.approveLabel")}: ${label(item)}`}
                onClick={() => setDialog({ item, decision: "approve" })}
              >
                {t("reviews.corrections.approve")}
              </Button>
              <Button
                kind="ghost"
                size="sm"
                disabled={busy}
                aria-label={`${t("reviews.corrections.rejectLabel")}: ${label(item)}`}
                onClick={() => setDialog({ item, decision: "reject" })}
              >
                {t("reviews.corrections.reject")}
              </Button>
            </>
          ) : (
            t("reviews.ownRequest")
          ),
        }))}
        emptyState={t("reviews.corrections.empty")}
      />
      <Modal
        // The dialog keeps the correction it opened for: a refreshed queue never changes it.
        key={dialog ? `${dialog.decision}-${dialog.item.correctionId}` : "none"}
        open={dialog !== undefined}
        size="sm"
        danger={dialog?.decision === "reject"}
        modalHeading={dialog ? t(`reviews.corrections.dialog.${dialog.decision}Title`) : ""}
        primaryButtonText={dialog ? t(`reviews.corrections.dialog.${dialog.decision}Confirm`) : ""}
        secondaryButtonText={t("reviews.dialog.cancel")}
        primaryButtonDisabled={busy}
        onRequestClose={() => setDialog(undefined)}
        onRequestSubmit={() => dialog && void decide(dialog.item, dialog.decision)}
      >
        {dialog && (
          <Stack gap={3}>
            <p>{label(dialog.item)}</p>
            <p>{t(`corrections.reasons.${dialog.item.reason}`)}</p>
            <p>{t("reviews.corrections.dialog.source", { source: dialog.item.source })}</p>
            {dialog.decision === "approve" && (
              <p>{t(`reviews.corrections.dialog.effect.${effect(dialog.item)}` as never)}</p>
            )}
            <p>{t("reviews.corrections.dialog.noStatus")}</p>
            <p>{t("reviews.corrections.dialog.final")}</p>
          </Stack>
        )}
      </Modal>
    </>
  );
}

type Clarification = components["schemas"]["ReviewQueue"]["clarifications"][number];

/** A clarification refusal's message key: its status or first code. */
function clarificationMessage(error: unknown): string {
  if (!(error instanceof ApiProblemError)) return "failed";
  if (error.status === 403) return "forbidden";
  if (error.status === 404) return "notFound";
  if (error.status === 409) return "conflict";
  const code = error.problem.errors?.[0]?.code;
  return error.status === 422 && code ? `codes.${code}` : "failed";
}

/**
 * The escalated entry clarifications (process-and-lifecycle.md, the entry clarification): per case
 * the project, the planned start it opened for, the steps so far with their documented sources,
 * never a name or the participation. "Weisung erfassen" records the manager's instruction and
 * "Rückfrage an die PL" asks the PL again (a code and one source line each), against the status
 * version and the revision shown; neither changes a status and the case stays open. Never the
 * PL's, nor the person who escalated; the API checks it again.
 */
function ClarificationQueue(props: {
  clarifications: Clarification[];
  onDecided: (message: { kind: "success" | "error"; text: string }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const api = useApi();
  // The dialog keeps the case it opened for: a refreshed queue never changes it.
  const [dialog, setDialog] = useState<{ item: Clarification; mode: "instruction" | "request" }>();
  const [code, setCode] = useState("");
  const [source, setSource] = useState("");
  const [shownInvalid, setShownInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const label = (item: Clarification) =>
    t("reviews.clarifications.item", {
      project: item.projectName,
      date: formatDate(item.tgStart),
    });
  const normalised = normaliseCorrectionSource(source);
  const sourceValid = normalised !== null && normalised.length <= correctionSourceMaxLength;
  const close = () => {
    setDialog(undefined);
    setCode("");
    setSource("");
    setShownInvalid(false);
  };
  const stepText = (step: Clarification["steps"][number]) =>
    t("entryClarification.history.step", {
      date: formatDate(step.on),
      kind: t(`entryClarification.history.kinds.${step.kind}`),
      code: t(
        `entryClarification.${
          step.kind === "requested"
            ? "requestCodes"
            : step.kind === "instructed"
              ? "instructionCodes"
              : "pendingCodes"
        }.${step.code}` as never,
      ),
      source: step.source,
    });

  async function record({ item, mode }: NonNullable<typeof dialog>) {
    if (code === "" || !sourceValid) {
      setShownInvalid(true);
      return;
    }
    setBusy(true);
    let result: { kind: "success" | "error"; text: string };
    try {
      const params = { params: { path: { clarificationId: item.id } } };
      const common = { source, statusVersion: item.statusVersion, revision: item.revision };
      const { error } =
        mode === "instruction"
          ? await api.POST("/api/v1/entry-clarifications/{clarificationId}/instruction", {
              ...params,
              body: { ...common, code: code as components["schemas"]["EntryInstructionCode"] },
            })
          : await api.POST("/api/v1/entry-clarifications/{clarificationId}/request", {
              ...params,
              body: { ...common, code: code as components["schemas"]["EntryRequestCode"] },
            });
      if (error) throw error;
      result = {
        kind: "success",
        text: t(
          mode === "instruction"
            ? "reviews.clarifications.messages.instructed"
            : "reviews.clarifications.messages.requested",
        ),
      };
    } catch (error) {
      result = {
        kind: "error",
        text: t(`reviews.clarifications.messages.${clarificationMessage(error)}` as never, {
          defaultValue: t("reviews.clarifications.messages.failed"),
        }),
      };
    } finally {
      setBusy(false);
      close();
    }
    await props.onDecided(result);
  }

  const options =
    dialog?.mode === "request" ? EntryRequestCode.options : EntryInstructionCode.options;
  const optionLabel = (option: string) =>
    t(
      `entryClarification.${dialog?.mode === "request" ? "requestCodes" : "instructionCodes"}.${option}` as never,
    );
  return (
    <>
      <SimpleTable
        title={t("reviews.clarifications.listTitle")}
        columns={(["project", "tgStart", "escalatedOn", "history", "actions"] as const).map(
          (key) => ({ key, header: t(`reviews.clarifications.columns.${key}`) }),
        )}
        rows={props.clarifications.map((item) => ({
          id: item.id,
          project: item.projectName,
          tgStart: formatDate(item.tgStart),
          escalatedOn: formatDate(item.escalatedOn),
          history: (
            <ol className="tp-list">
              {item.steps.map((step, index) => (
                <li key={index}>{stepText(step)}</li>
              ))}
            </ol>
          ),
          actions: item.capabilities.answer ? (
            <>
              <Button
                kind="ghost"
                size="sm"
                disabled={busy}
                aria-label={`${t("reviews.clarifications.instruct")}: ${label(item)}`}
                onClick={() => setDialog({ item, mode: "instruction" })}
              >
                {t("reviews.clarifications.instruct")}
              </Button>
              <Button
                kind="ghost"
                size="sm"
                disabled={busy}
                aria-label={`${t("reviews.clarifications.request")}: ${label(item)}`}
                onClick={() => setDialog({ item, mode: "request" })}
              >
                {t("reviews.clarifications.request")}
              </Button>
            </>
          ) : (
            t("reviews.clarifications.ownEscalation")
          ),
        }))}
        emptyState={t("reviews.clarifications.empty")}
      />
      <Modal
        key={dialog ? `${dialog.mode}-${dialog.item.id}-${dialog.item.revision}` : "none"}
        open={dialog !== undefined}
        size="sm"
        modalHeading={dialog ? t(`reviews.clarifications.dialog.${dialog.mode}.title`) : ""}
        primaryButtonText={t("reviews.clarifications.dialog.confirm")}
        secondaryButtonText={t("reviews.clarifications.dialog.cancel")}
        primaryButtonDisabled={busy}
        onRequestClose={close}
        onRequestSubmit={() => dialog && void record(dialog)}
      >
        {dialog && (
          <Stack gap={4}>
            <p>{label(dialog.item)}</p>
            <Select
              id="clarification-answer-code"
              labelText={t(`reviews.clarifications.dialog.${dialog.mode}.code`)}
              value={code}
              invalid={shownInvalid && code === ""}
              invalidText={t(`reviews.clarifications.dialog.${dialog.mode}.choose`)}
              onChange={(event) => setCode(event.target.value)}
            >
              <SelectItem value="" text="" />
              {options.map((option) => (
                <SelectItem key={option} value={option} text={optionLabel(option)} />
              ))}
            </Select>
            <TextInput
              id="clarification-answer-source"
              labelText={t("reviews.clarifications.dialog.source")}
              value={source}
              maxLength={correctionSourceMaxLength}
              invalid={shownInvalid && !sourceValid}
              invalidText={t("reviews.clarifications.dialog.enterSource")}
              onChange={(event) => setSource(event.target.value)}
            />
            <p>{t(`reviews.clarifications.dialog.${dialog.mode}.final`)}</p>
          </Stack>
        )}
      </Modal>
    </>
  );
}

type Reconciliation = components["schemas"]["ReviewQueue"]["reconciliations"][number];
type Outcome = Reconciliation["capabilities"]["outcomes"][number];

/**
 * The open reconciliations of a missed TG entry (process-and-lifecycle.md, the reconciliation; Q80,
 * Q216): per reconciliation the project, the TG start, the evidence's kinds with their valid and
 * recorded days, the review's steps with their documented sources and the day the review is due
 * (informational), never a name or the participation. "Ohne Einwand" and "Rückfrage" (a reason code
 * and one source line); after the PL's reply "Erledigt" or "An DSB eskaliert" (a source line); an
 * escalation is resolved on the DPO's documented instruction. The buttons are the viewer's
 * outcomes (none for the PL who reconciled); the API checks them again. Nothing reverses the entry.
 */
function ReconciliationQueue(props: {
  reconciliations: Reconciliation[];
  onDecided: (message: { kind: "success" | "error"; text: string }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const api = useApi();
  // The dialog keeps the reconciliation and the revision it opened for.
  const [dialog, setDialog] = useState<{ item: Reconciliation; outcome: Outcome }>();
  const [code, setCode] = useState("");
  const [source, setSource] = useState("");
  const [shownInvalid, setShownInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const label = (item: Reconciliation) =>
    t("reviews.reconciliations.item", {
      project: item.projectName,
      date: formatDate(item.tgStart),
    });
  const normalised = normaliseCorrectionSource(source);
  const sourceValid = normalised !== null && normalised.length <= correctionSourceMaxLength;
  const needsCode = dialog?.outcome === "clarification_requested";
  const needsSource = dialog !== undefined && dialog.outcome !== "no_objection";
  const close = () => {
    setDialog(undefined);
    setCode("");
    setSource("");
    setShownInvalid(false);
  };
  const stepText = (step: Reconciliation["steps"][number]) => reconciliationStepText(t, step);

  async function record({ item, outcome }: NonNullable<typeof dialog>) {
    if ((needsCode && code === "") || (needsSource && !sourceValid)) {
      setShownInvalid(true);
      return;
    }
    setBusy(true);
    let result: { kind: "success" | "error"; text: string };
    try {
      const body =
        outcome === "no_objection"
          ? { outcome, revision: item.revision }
          : outcome === "clarification_requested"
            ? {
                outcome,
                code: code as components["schemas"]["ReconciliationReasonCode"],
                source,
                revision: item.revision,
              }
            : { outcome, source, revision: item.revision };
      const { error } = await api.POST("/api/v1/reconciliations/{reconciliationId}/review", {
        params: { path: { reconciliationId: item.id } },
        body,
      });
      if (error) throw error;
      result = { kind: "success", text: t(`reviews.reconciliations.messages.${outcome}`) };
    } catch (error) {
      result = {
        kind: "error",
        text: t(`reviews.reconciliations.messages.${clarificationMessage(error)}` as never, {
          defaultValue: t("reviews.reconciliations.messages.failed"),
        }),
      };
    } finally {
      setBusy(false);
      close();
    }
    await props.onDecided(result);
  }

  return (
    <>
      <SimpleTable
        title={t("reviews.reconciliations.listTitle")}
        columns={(["project", "tgStart", "evidence", "stage", "history", "actions"] as const).map(
          (key) => ({ key, header: t(`reviews.reconciliations.columns.${key}`) }),
        )}
        rows={props.reconciliations.map((item) => ({
          id: item.id,
          project: item.projectName,
          tgStart: formatDate(item.tgStart),
          evidence: (
            <ul className="tp-list">
              {item.evidence.map((e) => (
                <li key={e.kind}>
                  {t("reconciliation.evidence.days", {
                    kind: t(`reconciliation.evidenceKinds.${e.kind}`),
                    valid: formatDate(e.validOn),
                    recorded: formatDate(e.recordedOn),
                  })}
                </li>
              ))}
            </ul>
          ),
          stage: t("reviews.reconciliations.stageOn", {
            stage: t(`reconciliation.stages.${item.stage}`),
            reconciled: formatDate(item.reconciledOn),
            due: formatDate(item.reviewDueOn),
          }),
          history:
            item.steps.length === 0 ? (
              "–"
            ) : (
              <ol className="tp-list">
                {item.steps.map((step, index) => (
                  <li key={index}>{stepText(step)}</li>
                ))}
              </ol>
            ),
          actions:
            item.capabilities.outcomes.length > 0 ? (
              <>
                {item.capabilities.outcomes.map((outcome) => (
                  <Button
                    key={outcome}
                    kind="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`${t(`reviews.reconciliations.outcomes.${outcome}`)}: ${label(item)}`}
                    onClick={() => setDialog({ item, outcome })}
                  >
                    {t(`reviews.reconciliations.outcomes.${outcome}`)}
                  </Button>
                ))}
              </>
            ) : (
              t(
                item.stage === "clarification_requested"
                  ? "reviews.reconciliations.awaitingReply"
                  : "reviews.reconciliations.ownReconciliation",
              )
            ),
        }))}
        emptyState={t("reviews.reconciliations.empty")}
      />
      <Modal
        key={dialog ? `${dialog.outcome}-${dialog.item.id}-${dialog.item.revision}` : "none"}
        open={dialog !== undefined}
        size="sm"
        modalHeading={dialog ? t(`reviews.reconciliations.outcomes.${dialog.outcome}`) : ""}
        primaryButtonText={t("reviews.reconciliations.dialog.confirm")}
        secondaryButtonText={t("reviews.reconciliations.dialog.cancel")}
        primaryButtonDisabled={busy}
        onRequestClose={close}
        onRequestSubmit={() => dialog && void record(dialog)}
      >
        {dialog && (
          <Stack gap={4}>
            <p>{label(dialog.item)}</p>
            {needsCode && (
              <Select
                id="reconciliation-review-code"
                labelText={t("reviews.reconciliations.dialog.code")}
                value={code}
                invalid={shownInvalid && code === ""}
                invalidText={t("reviews.reconciliations.dialog.choose")}
                onChange={(event) => setCode(event.target.value)}
              >
                <SelectItem value="" text="" />
                {ReconciliationReasonCode.options.map((option) => (
                  <SelectItem
                    key={option}
                    value={option}
                    text={t(`reconciliation.reasonCodes.${option}`)}
                  />
                ))}
              </Select>
            )}
            {needsSource && (
              <TextInput
                id="reconciliation-review-source"
                labelText={t("reviews.reconciliations.dialog.source")}
                value={source}
                maxLength={correctionSourceMaxLength}
                invalid={shownInvalid && !sourceValid}
                invalidText={t("reviews.reconciliations.dialog.enterSource")}
                onChange={(event) => setSource(event.target.value)}
              />
            )}
            <p>{t(`reviews.reconciliations.dialog.final.${dialog.outcome}`)}</p>
          </Stack>
        )}
      </Modal>
    </>
  );
}
