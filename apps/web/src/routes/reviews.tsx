import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  EntryInstructionCode,
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
  const { items, corrections, clarifications } = query.data;
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
 * the project, the planned start, the PL's code and documented source, never a name or the
 * participation. "Weisung erfassen" records the manager's instruction (a code and one source
 * line) against the status version shown; it changes no status and the case stays open. Never the
 * PL's, nor the person who escalated; the API checks it again.
 */
function ClarificationQueue(props: {
  clarifications: Clarification[];
  onDecided: (message: { kind: "success" | "error"; text: string }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const api = useApi();
  // The dialog keeps the case it opened for: a refreshed queue never changes it.
  const [dialog, setDialog] = useState<Clarification>();
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

  async function record(item: Clarification) {
    if (code === "" || !sourceValid) {
      setShownInvalid(true);
      return;
    }
    setBusy(true);
    let result: { kind: "success" | "error"; text: string };
    try {
      const { error } = await api.POST(
        "/api/v1/entry-clarifications/{clarificationId}/instruction",
        {
          params: { path: { clarificationId: item.id } },
          body: {
            code: code as components["schemas"]["EntryInstructionCode"],
            source,
            statusVersion: item.statusVersion,
          },
        },
      );
      if (error) throw error;
      result = { kind: "success", text: t("reviews.clarifications.messages.instructed") };
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

  return (
    <>
      <SimpleTable
        title={t("reviews.clarifications.listTitle")}
        columns={(
          ["project", "tgStart", "escalatedOn", "pending", "source", "actions"] as const
        ).map((key) => ({ key, header: t(`reviews.clarifications.columns.${key}`) }))}
        rows={props.clarifications.map((item) => ({
          id: item.id,
          project: item.projectName,
          tgStart: formatDate(item.tgStart),
          escalatedOn: formatDate(item.escalatedOn),
          pending: t(`entryClarification.pendingCodes.${item.pendingCode}`),
          source: item.pendingSource,
          actions: item.capabilities.instruct ? (
            <Button
              kind="ghost"
              size="sm"
              disabled={busy}
              aria-label={`${t("reviews.clarifications.instruct")}: ${label(item)}`}
              onClick={() => setDialog(item)}
            >
              {t("reviews.clarifications.instruct")}
            </Button>
          ) : (
            t("reviews.clarifications.ownEscalation")
          ),
        }))}
        emptyState={t("reviews.clarifications.empty")}
      />
      <Modal
        key={dialog?.id ?? "none"}
        open={dialog !== undefined}
        size="sm"
        modalHeading={t("reviews.clarifications.dialog.title")}
        primaryButtonText={t("reviews.clarifications.dialog.confirm")}
        secondaryButtonText={t("reviews.clarifications.dialog.cancel")}
        primaryButtonDisabled={busy}
        onRequestClose={close}
        onRequestSubmit={() => dialog && void record(dialog)}
      >
        {dialog && (
          <Stack gap={4}>
            <p>{label(dialog)}</p>
            <Select
              id="clarification-instruction-code"
              labelText={t("reviews.clarifications.dialog.code")}
              value={code}
              invalid={shownInvalid && code === ""}
              invalidText={t("reviews.clarifications.dialog.choose")}
              onChange={(event) => setCode(event.target.value)}
            >
              <SelectItem value="" text="" />
              {EntryInstructionCode.options.map((option) => (
                <SelectItem
                  key={option}
                  value={option}
                  text={t(`entryClarification.instructionCodes.${option}`)}
                />
              ))}
            </Select>
            <TextInput
              id="clarification-instruction-source"
              labelText={t("reviews.clarifications.dialog.source")}
              value={source}
              maxLength={correctionSourceMaxLength}
              invalid={shownInvalid && !sourceValid}
              invalidText={t("reviews.clarifications.dialog.enterSource")}
              onChange={(event) => setSource(event.target.value)}
            />
            <p>{t("reviews.clarifications.dialog.final")}</p>
          </Stack>
        )}
      </Modal>
    </>
  );
}
