import { useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import { DOCUMENT_ACCEPT, readFileAsBase64 } from "@transfer/self-service-ui";
import {
  Button,
  Checkbox,
  DateField,
  FileUploaderButton,
  formatDate,
  formatTimestamp,
  InlineNotification,
  Modal,
  parseDisplayDate,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  Stack,
  TextInput,
} from "@transfer/ui";
import { useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { participationProfilingQuery, participationQuery, useApi } from "../api";

// "Ausnahme vom Profiling" on the tab "Profiling" (process-and-lifecycle.md, profiling exceptions;
// data-protection.md, exception evidence; D30, Q194): the current request, the evidence documents
// as their upload date and review state (the PL uploads them, never opens them; the assigned
// consultant reviews them on "Unterlagen"), "Nachweis hochladen", "Ausnahme beantragen" with a
// reason and the evidence (reviewed documents or the Agentur's confirmation) and "Widerrufen".
// Nothing is chosen for the user: no default reason, evidence, document, Agentur or date. Every
// button follows the API's capabilities; every write sends a JSON body.

type Detail = components["schemas"]["ParticipationDetail"];
type View = components["schemas"]["Profiling"];
type Exception = View["exception"];
type Reason = components["schemas"]["ProfilingExceptionRequestInput"]["reason"];
type Evidence = components["schemas"]["ExceptionEvidenceInput"];

const reasons = [
  "participant_prevented_documented",
  "agentur_scheduling_unavailable",
  "force_majeure",
  "ba_confirmed_other",
] as const satisfies Reason[];

/** A refusal's message key: its first code's where there is one. */
function messageOf(error: unknown): string {
  if (!(error instanceof ApiProblemError)) return "failed";
  if (error.status === 403) return "forbidden";
  if (error.status === 404) return "notFound";
  const code = error.problem.errors?.[0]?.code;
  return (error.status === 422 || error.status === 409) && code ? `codes.${code}` : "failed";
}

export function ProfilingException({ view, detail }: { view: View; detail: Detail }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<"request" | "revoke" | null>(null);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string }>();
  const [busy, setBusy] = useState(false);
  const exception = view.exception;
  const { current, capabilities } = exception;
  const path = { participationId: view.participationId };

  /** Runs a write; the tab and the participation are read again whatever happened. */
  async function act(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setMessage(undefined);
    try {
      await action();
      setMessage({ kind: "success", text: t(`profiling.exception.messages.${done}` as never) });
      setDialog(null);
    } catch (error) {
      setMessage({
        kind: "error",
        text: t(`profiling.exception.messages.${messageOf(error)}` as never, {
          defaultValue: t("profiling.exception.messages.failed"),
        }),
      });
    } finally {
      setBusy(false);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: participationProfilingQuery(api, view.participationId).queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: participationQuery(api, view.participationId).queryKey,
        }),
      ]);
    }
  }

  const upload = (file: File) =>
    act(async () => {
      const content = await readFileAsBase64(file);
      const { error } = await api.POST("/api/v1/participations/{participationId}/documents", {
        params: { path },
        body: { type: "profiling_exception_evidence", fileName: file.name, content },
      });
      if (error) throw error;
    }, "uploaded");

  /** The evidence record first, then the request resting on it. */
  const request = (reason: Reason, evidence: Evidence) =>
    act(async () => {
      const recorded = await api.POST(
        "/api/v1/participations/{participationId}/exception-evidence",
        { params: { path }, body: evidence },
      );
      if (!recorded.data) throw recorded.error;
      const { error } = await api.POST(
        "/api/v1/participations/{participationId}/profiling-exception-requests",
        { params: { path }, body: { reason, evidenceRecordId: recorded.data.evidenceRecordId } },
      );
      if (error) throw error;
    }, "requested");

  const revoke = () =>
    act(async () => {
      if (!current || (current.status !== "requested" && current.status !== "approved")) return;
      const { error } = await api.POST(
        "/api/v1/profiling-exception-requests/{requestId}/revocation",
        {
          params: { path: { requestId: current.requestId } },
          // The status shown here: one decided meanwhile is refused (409), never revoked unseen.
          body: { status: current.status },
        },
      );
      if (error) throw error;
    }, "revoked");

  const shown = current !== null || exception.evidenceDocuments.length > 0 || capabilities.request;
  if (!shown && !capabilities.addEvidence) return null;
  return (
    <section className="tp-section" aria-labelledby="profiling-exception">
      <Stack gap={5}>
        <h2 id="profiling-exception">{t("profiling.exception.title")}</h2>
        <p>{t("profiling.exception.intro")}</p>
        {message && (
          <InlineNotification
            kind={message.kind}
            role={message.kind === "error" ? "alert" : "status"}
            title={message.text}
            onClose={() => setMessage(undefined)}
            lowContrast
          />
        )}
        <CurrentRequest current={current} />
        <EvidenceDocuments exception={exception} />
        <div className="tp-actions">
          {capabilities.addEvidence && (
            <FileUploaderButton
              id="profiling-exception-evidence-file"
              labelText={t("profiling.exception.upload")}
              accept={DOCUMENT_ACCEPT}
              buttonKind="tertiary"
              size="md"
              disabled={busy}
              disableLabelChanges
              multiple={false}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
              }}
            />
          )}
          {capabilities.request && (
            <Button kind="primary" size="md" disabled={busy} onClick={() => setDialog("request")}>
              {t("profiling.exception.request")}
            </Button>
          )}
          {capabilities.revoke && (
            <Button
              kind="danger--tertiary"
              size="md"
              disabled={busy}
              onClick={() => setDialog("revoke")}
            >
              {t("profiling.exception.revoke")}
            </Button>
          )}
        </div>
      </Stack>
      <RequestDialog
        // A new dialog starts empty, and again after each request: nothing carried over.
        key={`request-${dialog === "request"}-${current?.requestId ?? "none"}`}
        open={dialog === "request"}
        busy={busy}
        exception={exception}
        choices={detail.placementAgenturChoices}
        onClose={() => setDialog(null)}
        onSubmit={request}
      />
      <Modal
        open={dialog === "revoke"}
        size="sm"
        danger
        modalHeading={t("profiling.exception.revokeDialog.title")}
        primaryButtonText={t("profiling.exception.revokeDialog.confirm")}
        secondaryButtonText={t("profiling.exception.dialog.cancel")}
        primaryButtonDisabled={busy}
        onRequestClose={() => setDialog(null)}
        onRequestSubmit={() => void revoke()}
      >
        {current && (
          <p>
            {t("profiling.exception.revokeDialog.text", {
              status: t(`profiling.exception.statuses.${current.status}`),
              date: formatDate(current.requestedOn),
            })}
          </p>
        )}
      </Modal>
    </section>
  );
}

function CurrentRequest({ current }: { current: Exception["current"] }) {
  const { t } = useTranslation();
  if (!current) return <p>{t("profiling.exception.none")}</p>;
  return (
    <dl className="tp-facts">
      <dt>{t("profiling.exception.status")}</dt>
      <dd>{t(`profiling.exception.statuses.${current.status}`)}</dd>
      <dt>{t("profiling.exception.reason")}</dt>
      <dd>{t(`history.reasons.${current.reason}`)}</dd>
      <dt>{t("profiling.exception.requestedOn")}</dt>
      <dd>{formatDate(current.requestedOn)}</dd>
      {current.decidedOn && (
        <>
          <dt>{t("profiling.exception.decidedOn")}</dt>
          <dd>{formatDate(current.decidedOn)}</dd>
        </>
      )}
      <dt>{t("profiling.exception.evidence")}</dt>
      <dd>{t(`profiling.exception.kinds.${current.evidenceKind}`)}</dd>
    </dl>
  );
}

/** The evidence documents by upload instant and review state; never a file or a name. */
function EvidenceDocuments({ exception }: { exception: Exception }) {
  const { t } = useTranslation();
  if (exception.evidenceDocuments.length === 0) return null;
  return (
    <Stack gap={3}>
      <h3>{t("profiling.exception.documents")}</h3>
      <ul>
        {exception.evidenceDocuments.map((document) => (
          <li key={document.documentId}>
            {t("profiling.exception.document", {
              at: formatTimestamp(document.addedAt),
              state: t(
                `profiling.exception.documentStates.${document.usable ? "usable" : document.reviewState}`,
              ),
            })}
          </li>
        ))}
      </ul>
      <p className="tp-hint">{t("profiling.exception.reviewHint")}</p>
    </Stack>
  );
}

/** "Ausnahme beantragen": the reason and the evidence, each chosen explicitly. */
function RequestDialog(props: {
  open: boolean;
  busy: boolean;
  exception: Exception;
  choices: Detail["placementAgenturChoices"];
  onClose: () => void;
  onSubmit: (reason: Reason, evidence: Evidence) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<Reason | "">("");
  const [kind, setKind] = useState<Evidence["kind"] | "">("");
  const [documentIds, setDocumentIds] = useState<string[]>([]);
  const [agenturKey, setAgenturKey] = useState("");
  const [reference, setReference] = useState("");
  const [confirmedOn, setConfirmedOn] = useState("");
  const [invalidDate, setInvalidDate] = useState(false);
  const usable = props.exception.evidenceDocuments.filter((document) => document.usable);
  const complete =
    reason !== "" &&
    (kind === "documents"
      ? documentIds.length > 0
      : kind === "ba_confirmation" &&
        agenturKey !== "" &&
        reference.trim() !== "" &&
        confirmedOn !== "");
  const submit = async () => {
    if (!complete) return;
    if (kind === "documents") {
      await props.onSubmit(reason, { kind, documentIds });
      return;
    }
    const parsed = parseDisplayDate(confirmedOn);
    if (!parsed.ok || parsed.value === undefined) {
      setInvalidDate(true);
      return;
    }
    setInvalidDate(false);
    await props.onSubmit(reason, {
      kind: "ba_confirmation",
      agenturKey,
      reference,
      confirmedOn: parsed.value,
    });
  };
  return (
    <Modal
      open={props.open}
      size="md"
      modalHeading={t("profiling.exception.dialog.title")}
      primaryButtonText={t("profiling.exception.dialog.confirm")}
      secondaryButtonText={t("profiling.exception.dialog.cancel")}
      primaryButtonDisabled={props.busy || !complete}
      onRequestClose={props.onClose}
      onRequestSubmit={() => void submit()}
    >
      <Stack gap={5}>
        <Select
          id="profiling-exception-reason"
          labelText={t("profiling.exception.dialog.reason")}
          value={reason}
          onChange={(event) => setReason(event.target.value as Reason | "")}
        >
          <SelectItem value="" text={t("profiling.exception.dialog.chooseReason")} />
          {reasons.map((option) => (
            <SelectItem key={option} value={option} text={t(`history.reasons.${option}`)} />
          ))}
        </Select>
        <RadioButtonGroup
          name="profiling-exception-evidence-kind"
          legendText={t("profiling.exception.dialog.evidence")}
          orientation="vertical"
          valueSelected={kind}
          onChange={(value) => setKind(value as Evidence["kind"])}
        >
          <RadioButton
            id="profiling-exception-kind-documents"
            value="documents"
            labelText={t("profiling.exception.dialog.documents", { count: usable.length })}
            disabled={usable.length === 0}
          />
          <RadioButton
            id="profiling-exception-kind-ba"
            value="ba_confirmation"
            labelText={t("profiling.exception.dialog.baConfirmation")}
          />
        </RadioButtonGroup>
        {usable.length === 0 && (
          <p className="tp-hint">{t("profiling.exception.dialog.noDocuments")}</p>
        )}
        {kind === "documents" && (
          <fieldset>
            <legend>{t("profiling.exception.dialog.chooseDocuments")}</legend>
            {usable.map((document) => (
              <Checkbox
                key={document.documentId}
                id={`profiling-exception-document-${document.documentId}`}
                labelText={t("profiling.exception.dialog.document", {
                  at: formatTimestamp(document.addedAt),
                })}
                checked={documentIds.includes(document.documentId)}
                onChange={(_event, { checked }) =>
                  setDocumentIds((ids) =>
                    checked
                      ? [...ids, document.documentId]
                      : ids.filter((id) => id !== document.documentId),
                  )
                }
              />
            ))}
          </fieldset>
        )}
        {kind === "ba_confirmation" && (
          <>
            <Select
              id="profiling-exception-agentur"
              labelText={t("profiling.exception.dialog.agentur")}
              value={agenturKey}
              onChange={(event) => setAgenturKey(event.target.value)}
            >
              <SelectItem value="" text={t("profiling.exception.dialog.chooseAgentur")} />
              {props.choices.map((choice) => (
                <SelectItem
                  key={choice.agenturKey}
                  value={choice.agenturKey}
                  text={`${choice.label.de} (${choice.agenturKey})`}
                />
              ))}
            </Select>
            <TextInput
              id="profiling-exception-reference"
              labelText={t("profiling.exception.dialog.reference")}
              helperText={t("profiling.exception.dialog.referenceHelp")}
              maxLength={100}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
            <DateField
              id="profiling-exception-confirmed-on"
              labelText={t("profiling.exception.dialog.confirmedOn")}
              defaultValue={confirmedOn}
              onChange={setConfirmedOn}
              invalidText={invalidDate ? t("profiling.exception.dialog.invalidDate") : undefined}
            />
          </>
        )}
        <p>{t("profiling.exception.dialog.final")}</p>
      </Stack>
    </Modal>
  );
}
