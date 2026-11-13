import { useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  Button,
  DateField,
  formatDate,
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
import { participationProfilingQuery, useApi } from "../api";

// "Übermittlung an die Agentur" on the tab "Profiling" (process-and-lifecycle.md, TL 407
// submission; D26, Q189): the PL records "An Agentur übermittelt am" for the accepted signed
// TL 407 by the placement Agentur's channel, "Original versandt am" where the Agentur needs the
// paper original, and "Von der Agentur abgelehnt", which reopens the submission; every attempt is
// listed. The assigned consultant reads the attempts. Every button follows the API's capabilities;
// each write sends a JSON body and the tab is read again afterwards.

type View = components["schemas"]["Profiling"];
type Attempt = components["schemas"]["Tl407Submission"];
type Reason = components["schemas"]["AgenturRejectionReason"];
type Dialog = { kind: "original" | "rejection" | "retained"; attempt: Attempt } | { kind: "none" };

const reasons = ["outdated_form_version", "incomplete", "other"] as const satisfies Reason[];

/** A refusal's text: its first code's where there is one. */
function messageOf(error: unknown): string {
  if (!(error instanceof ApiProblemError)) return "failed";
  if (error.status === 409) return "conflict";
  if (error.status === 403) return "forbidden";
  const code = error.problem.errors?.[0]?.code;
  return error.status === 422 && code ? `codes.${code}` : "failed";
}

export function Tl407Submission({ view }: { view: View }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string }>();
  const [busy, setBusy] = useState(false);
  const { attempts, next } = view.tl407Submission;
  const channel = (code: string) => t(`overrides.values.${code}` as never, { defaultValue: code });

  /** Runs a write (a problem throws `ApiProblemError`); the tab is read again afterwards. */
  async function act(write: () => Promise<unknown>) {
    setBusy(true);
    setMessage(undefined);
    try {
      await write();
      setMessage({ kind: "success", text: t("profiling.submission.messages.saved") });
      setDialog({ kind: "none" });
      return true;
    } catch (error) {
      const key = messageOf(error);
      setMessage({
        kind: "error",
        text: t(`profiling.submission.messages.${key}` as never, {
          defaultValue: t("profiling.submission.messages.failed"),
        }),
      });
      return false;
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({
        queryKey: participationProfilingQuery(api, view.participationId).queryKey,
      });
    }
  }

  if (next === null && attempts.length === 0) return null;
  const outdated = attempts.find((a) => a.rejection?.reason === "outdated_form_version");
  return (
    <>
      <Stack gap={5}>
        {message && (
          <InlineNotification
            kind={message.kind}
            role={message.kind === "error" ? "alert" : "status"}
            title={message.text}
            onClose={() => setMessage(undefined)}
            lowContrast
          />
        )}
        {outdated && (
          <InlineNotification
            kind="warning"
            title={t("profiling.submission.versionCheck", {
              version: outdated.formVersion.replace("-", "/"),
            })}
            hideCloseButton
            lowContrast
          />
        )}
        {next && (
          <NextSubmission
            // A new attempt starts empty, never with the previous attempt's date.
            key={attempts.length}
            next={next}
            channel={channel}
            busy={busy}
            onSubmit={(submittedOn) =>
              act(() =>
                api.POST("/api/v1/participations/{participationId}/tl407-submissions", {
                  params: { path: { participationId: view.participationId } },
                  body: {
                    documentId: next.documentId!,
                    agenturKey: next.agenturKey!,
                    channel: next.channel!,
                    originalRequired: next.originalRequired!,
                    submittedOn,
                  },
                }),
              )
            }
          />
        )}
        {attempts.length > 0 && (
          <SimpleTable
            title={t("profiling.submission.attempts")}
            columns={[
              { key: "submittedOn", header: t("profiling.submission.columns.submittedOn") },
              { key: "channel", header: t("profiling.submission.columns.channel") },
              { key: "version", header: t("profiling.submission.columns.version") },
              { key: "original", header: t("profiling.submission.columns.original") },
              { key: "rejection", header: t("profiling.submission.columns.rejection") },
              { key: "actions", header: t("profiling.submission.columns.actions") },
            ]}
            rows={attempts.map((attempt) => ({
              id: attempt.id,
              submittedOn: formatDate(attempt.submittedOn),
              channel: `${attempt.agenturKey}, ${channel(attempt.channel)}`,
              version: attempt.formVersion.replace("-", "/"),
              original: attempt.originalSentOn
                ? attempt.originalRetainedFrom
                  ? t("profiling.submission.originalRetained", {
                      date: formatDate(attempt.originalSentOn),
                    })
                  : formatDate(attempt.originalSentOn)
                : attempt.rejection
                  ? "–"
                  : !attempt.originalRequired
                    ? t("profiling.submission.originalNotRequired")
                    : attempt.channel === "paper_original"
                      ? t("profiling.submission.originalWithSubmission")
                      : t("profiling.submission.originalMissing"),
              rejection: attempt.rejection
                ? t("profiling.submission.rejected", {
                    date: formatDate(attempt.rejection.rejectedOn),
                    reason: t(`profiling.submission.reasons.${attempt.rejection.reason}`),
                  })
                : "",
              actions: (
                <>
                  {attempt.retainableOriginal && (
                    <Button
                      kind="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setDialog({ kind: "retained", attempt })}
                    >
                      {t("profiling.submission.confirmRetained")}
                    </Button>
                  )}
                  {attempt.capabilities.recordOriginal && (
                    <Button
                      kind="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setDialog({ kind: "original", attempt })}
                    >
                      {t("profiling.submission.recordOriginal")}
                    </Button>
                  )}
                  {attempt.capabilities.recordRejection && (
                    <Button
                      kind="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setDialog({ kind: "rejection", attempt })}
                    >
                      {t("profiling.submission.recordRejection")}
                    </Button>
                  )}
                </>
              ),
            }))}
            emptyState=""
          />
        )}
      </Stack>
      <RetainedDialog
        dialog={dialog}
        busy={busy}
        onClose={() => setDialog({ kind: "none" })}
        onConfirm={(attempt) =>
          act(() =>
            api.POST("/api/v1/agentur-submissions/{submissionId}/original-retained", {
              params: { path: { submissionId: attempt.id } },
              body: { retainedFrom: attempt.retainableOriginal!.submissionId },
            }),
          )
        }
      />
      <FollowUpDialog
        dialog={dialog}
        busy={busy}
        onClose={() => setDialog({ kind: "none" })}
        onOriginal={(attempt, originalSentOn) =>
          act(() =>
            api.POST("/api/v1/agentur-submissions/{submissionId}/original", {
              params: { path: { submissionId: attempt.id } },
              body: { originalSentOn },
            }),
          )
        }
        onRejection={(attempt, rejectedOn, reason) =>
          act(() =>
            api.POST("/api/v1/agentur-submissions/{submissionId}/rejection", {
              params: { path: { submissionId: attempt.id } },
              body: { rejectedOn, reason },
            }),
          )
        }
      />
    </>
  );
}

/**
 * "Original liegt der Agentur vor" (Q206 (4)): the PL confirms that the same Agentur still holds
 * the original dispatched with an earlier attempt of this paper; the earlier date is kept.
 */
function RetainedDialog(props: {
  dialog: Dialog;
  busy: boolean;
  onClose: () => void;
  onConfirm: (attempt: Attempt) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const attempt = props.dialog.kind === "retained" ? props.dialog.attempt : undefined;
  const held = attempt?.retainableOriginal;
  return (
    <Modal
      open={held !== undefined && held !== null}
      size="sm"
      modalHeading={t("profiling.submission.retainedTitle")}
      primaryButtonText={t("profiling.submission.retainedConfirm")}
      secondaryButtonText={t("profiling.submission.cancel")}
      primaryButtonDisabled={props.busy}
      onRequestClose={props.onClose}
      onRequestSubmit={() => {
        if (attempt) void props.onConfirm(attempt);
      }}
    >
      {attempt && held && (
        <p>
          {t("profiling.submission.retainedText", {
            agentur: attempt.agenturKey,
            date: formatDate(held.originalSentOn),
          })}
        </p>
      )}
    </Modal>
  );
}

/** The next submission as the API would record it, or why there is none. */
function NextSubmission(props: {
  next: NonNullable<View["tl407Submission"]["next"]>;
  channel: (code: string) => string;
  busy: boolean;
  onSubmit: (submittedOn: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [date, setDate] = useState("");
  const [invalid, setInvalid] = useState(false);
  const { next } = props;
  if (next.problem !== null) {
    return (
      <p>
        {t(`profiling.submission.problems.${next.problem}` as never, {
          defaultValue: next.problem,
        })}
      </p>
    );
  }
  const submit = () => {
    const parsed = parseDisplayDate(date);
    if (!parsed.ok || parsed.value === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    void props.onSubmit(parsed.value);
  };
  return (
    <Stack gap={4}>
      <p>
        {t("profiling.submission.next", {
          version: (next.formVersion ?? "").replace("-", "/"),
          agentur: next.agenturKey,
          channel: props.channel(next.channel ?? ""),
        })}{" "}
        {t(
          next.originalRequired
            ? "profiling.submission.originalRequired"
            : "profiling.submission.originalNotNeeded",
        )}
      </p>
      <DateField
        id="tl407-submitted-on"
        labelText={t("profiling.submission.submittedOn")}
        defaultValue={date}
        onChange={setDate}
        invalidText={invalid ? t("profiling.submission.invalidDate") : undefined}
      />
      <div>
        <Button size="md" disabled={props.busy} onClick={submit}>
          {t("profiling.submission.submit")}
        </Button>
      </div>
    </Stack>
  );
}

/** "Original versandt am" or "Von der Agentur abgelehnt" for one attempt. */
function FollowUpDialog(props: {
  dialog: Dialog;
  busy: boolean;
  onClose: () => void;
  onOriginal: (attempt: Attempt, originalSentOn: string) => Promise<boolean>;
  onRejection: (attempt: Attempt, rejectedOn: string, reason: Reason) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [date, setDate] = useState("");
  const [reason, setReason] = useState<Reason | "">("");
  const [invalid, setInvalid] = useState(false);
  const { dialog } = props;
  const kind = dialog.kind === "original" || dialog.kind === "rejection" ? dialog.kind : undefined;
  const close = () => {
    setDate("");
    setReason("");
    setInvalid(false);
    props.onClose();
  };
  const submit = async () => {
    if (dialog.kind !== "original" && dialog.kind !== "rejection") return;
    const parsed = parseDisplayDate(date);
    if (!parsed.ok || parsed.value === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const done =
      dialog.kind === "original"
        ? await props.onOriginal(dialog.attempt, parsed.value)
        : reason !== "" && (await props.onRejection(dialog.attempt, parsed.value, reason));
    if (done) {
      setDate("");
      setReason("");
    }
  };
  return (
    <Modal
      open={kind !== undefined}
      size="sm"
      modalHeading={kind ? t(`profiling.submission.${kind}Title`) : ""}
      primaryButtonText={t("profiling.submission.confirm")}
      secondaryButtonText={t("profiling.submission.cancel")}
      primaryButtonDisabled={props.busy || date === "" || (kind === "rejection" && reason === "")}
      onRequestClose={close}
      onRequestSubmit={() => void submit()}
    >
      {kind && (
        <Stack gap={5}>
          {kind === "rejection" && <p>{t("profiling.submission.rejectionText")}</p>}
          <DateField
            id={`tl407-${kind}-on`}
            labelText={t(`profiling.submission.${kind}On`)}
            defaultValue={date}
            onChange={setDate}
            invalidText={invalid ? t("profiling.submission.invalidDate") : undefined}
          />
          {kind === "rejection" && (
            <Select
              id="tl407-rejection-reason"
              labelText={t("profiling.submission.reason")}
              value={reason}
              onChange={(event) => setReason(event.target.value as Reason | "")}
            >
              <SelectItem value="" text={t("profiling.submission.chooseReason")} />
              {reasons.map((option) => (
                <SelectItem
                  key={option}
                  value={option}
                  text={t(`profiling.submission.reasons.${option}`)}
                />
              ))}
            </Select>
          )}
        </Stack>
      )}
    </Modal>
  );
}
