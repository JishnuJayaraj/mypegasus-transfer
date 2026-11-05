import { useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  Button,
  DateField,
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
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  participationAsuQuery,
  participationDocumentsQuery,
  participationHistoryQuery,
  participationProfilingQuery,
  participationQuery,
  useApi,
  worklistQuery,
} from "../api";

// "Korrektur beantragen" (data-protection.md, evidence corrections; D29; readings Q209): the PL
// asks for an approved correction of one piece of wrong evidence: invalidate an accepted document
// (stating whether it is a wrong person's file), supersede an ASU registration with the corrected
// date or invalidate it, or supersede a closed BA outcome. The reason code and the documented
// source are always chosen and typed by the PL: nothing is preset. The dialog captures its target
// when it opens and never adopts another (a replacement, a refreshed state); the regional
// operations manager decides in "Freigaben". The button follows the API's capability.

type Input = components["schemas"]["EvidenceCorrectionRequestInput"];
type Reason = Input["reason"];

/** What the correction targets, as captured when the dialog opens. */
export type CorrectionTarget =
  | { kind: "document"; id: string; label: string }
  /** On `kug_200b` the date is the batch's: only an invalidation is offered (Q209 (3)). */
  | { kind: "asu_registration"; id: string; label: string; kug200b: boolean }
  | { kind: "ba_reporting_task"; id: string; label: string };

const reasons = [
  "ba_legal_reference",
  "data_subject_rectification",
  "corrected_source_document",
  "documented_internal_error",
] as const satisfies Reason[];

/** A refusal's message key: its first code's where there is one. */
function messageOf(error: unknown): string {
  if (!(error instanceof ApiProblemError)) return "failed";
  if (error.status === 403) return "forbidden";
  if (error.status === 404) return "notFound";
  const code = error.problem.errors?.[0]?.code;
  return error.status === 422 && code ? `codes.${code}` : "failed";
}

/**
 * "Korrektur beantragen" for a section: `button(target)` beside each target, `element` once at the
 * section's root (never inside a table cell), holding the dialog and its message. The dialog keeps
 * the target it opened for.
 */
export function useCorrectionRequest(scope: { participationId: string; projectId: string }) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState<CorrectionTarget>();
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string }>();
  const button = (target: CorrectionTarget) => (
    <Button
      kind="ghost"
      size="sm"
      aria-label={`${t("corrections.request")}: ${target.label}`}
      onClick={() => {
        setMessage(undefined);
        setOpened(target);
      }}
    >
      {t("corrections.request")}
    </Button>
  );
  const element = (
    <>
      {message && (
        <InlineNotification
          kind={message.kind}
          role={message.kind === "error" ? "alert" : "status"}
          title={message.text}
          onClose={() => setMessage(undefined)}
          lowContrast
        />
      )}
      {opened && (
        <CorrectionDialog
          // A new dialog starts empty: never another target's values.
          key={`${opened.kind}-${opened.id}`}
          participationId={scope.participationId}
          projectId={scope.projectId}
          target={opened}
          onClose={(result) => {
            setOpened(undefined);
            if (result) setMessage(result);
          }}
        />
      )}
    </>
  );
  return { button, element };
}

function CorrectionDialog(props: {
  participationId: string;
  projectId: string;
  target: CorrectionTarget;
  onClose: (message?: { kind: "success" | "error"; text: string }) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const { target, participationId } = props;
  const [reason, setReason] = useState<Reason | "">("");
  const [source, setSource] = useState("");
  const [wrongPerson, setWrongPerson] = useState<"yes" | "no" | "">("");
  const [action, setAction] = useState<"supersede" | "invalidate" | "">(
    // The one permitted action, not a preset: there is nothing else to choose.
    target.kind === "asu_registration" && target.kug200b ? "invalidate" : "",
  );
  const [date, setDate] = useState("");
  const [invalidDate, setInvalidDate] = useState(false);
  const [busy, setBusy] = useState(false);

  /** The body for what was chosen, or undefined while something is missing. */
  function body(): Input | undefined {
    if (reason === "" || source.trim() === "") return undefined;
    const base = { reason, source };
    if (target.kind === "document") {
      if (wrongPerson === "") return undefined;
      return {
        correction: "invalidate_document",
        documentId: target.id,
        wrongPerson: wrongPerson === "yes",
        ...base,
      };
    }
    if (target.kind === "ba_reporting_task") {
      return { correction: "supersede_ba_report", taskId: target.id, ...base };
    }
    if (action === "invalidate") {
      return { correction: "invalidate_asu_registration", registrationId: target.id, ...base };
    }
    if (action === "supersede" && date !== "") {
      const parsed = parseDisplayDate(date);
      if (!parsed.ok || parsed.value === undefined) return undefined;
      return {
        correction: "supersede_asu_registration",
        registrationId: target.id,
        registeredOn: parsed.value,
        ...base,
      };
    }
    return undefined;
  }

  async function submit() {
    if (target.kind === "asu_registration" && action === "supersede") {
      const parsed = parseDisplayDate(date);
      setInvalidDate(!parsed.ok || parsed.value === undefined);
    }
    const input = body();
    if (!input) return;
    setBusy(true);
    let result: { kind: "success" | "error"; text: string };
    try {
      await api.POST("/api/v1/participations/{participationId}/evidence-corrections", {
        params: { path: { participationId } },
        body: input,
      });
      result = { kind: "success", text: t("corrections.messages.requested") };
    } catch (error) {
      result = {
        kind: "error",
        text: t(`corrections.messages.${messageOf(error)}` as never, {
          defaultValue: t("corrections.messages.failed"),
        }),
      };
    } finally {
      setBusy(false);
    }
    await Promise.all(
      [
        participationQuery(api, participationId),
        participationAsuQuery(api, participationId),
        participationDocumentsQuery(api, participationId),
        participationProfilingQuery(api, participationId),
        participationHistoryQuery(api, participationId),
        worklistQuery(api, props.projectId),
      ].map(({ queryKey }) => queryClient.invalidateQueries({ queryKey })),
    );
    props.onClose(result);
  }

  return (
    <Modal
      open
      size="sm"
      modalHeading={t("corrections.dialog.title")}
      primaryButtonText={t("corrections.dialog.confirm")}
      secondaryButtonText={t("corrections.dialog.cancel")}
      primaryButtonDisabled={busy || body() === undefined}
      onRequestClose={() => props.onClose()}
      onRequestSubmit={() => void submit()}
    >
      <Stack gap={5}>
        <p>{t("corrections.dialog.target", { target: target.label })}</p>
        {target.kind === "document" && (
          <RadioButtonGroup
            name="correction-wrong-person"
            legendText={t("corrections.dialog.wrongPerson")}
            orientation="vertical"
            valueSelected={wrongPerson}
            onChange={(value) => setWrongPerson(value as "yes" | "no")}
          >
            <RadioButton
              id="correction-wrong-person-yes"
              value="yes"
              labelText={t("corrections.dialog.wrongPersonYes")}
            />
            <RadioButton
              id="correction-wrong-person-no"
              value="no"
              labelText={t("corrections.dialog.wrongPersonNo")}
            />
          </RadioButtonGroup>
        )}
        {target.kind === "asu_registration" && target.kug200b && (
          <p>{t("corrections.dialog.kug200bOnlyInvalidate")}</p>
        )}
        {target.kind === "asu_registration" && !target.kug200b && (
          <>
            <RadioButtonGroup
              name="correction-action"
              legendText={t("corrections.dialog.action")}
              orientation="vertical"
              valueSelected={action}
              onChange={(value) => setAction(value as "supersede" | "invalidate")}
            >
              <RadioButton
                id="correction-action-supersede"
                value="supersede"
                labelText={t("corrections.dialog.supersede")}
              />
              <RadioButton
                id="correction-action-invalidate"
                value="invalidate"
                labelText={t("corrections.dialog.invalidate")}
              />
            </RadioButtonGroup>
            {action === "supersede" && (
              <DateField
                id="correction-registered-on"
                labelText={t("corrections.dialog.registeredOn")}
                defaultValue={date}
                onChange={setDate}
                invalidText={invalidDate ? t("corrections.dialog.invalidDate") : undefined}
              />
            )}
          </>
        )}
        {target.kind === "ba_reporting_task" && <p>{t("corrections.dialog.replacement")}</p>}
        <Select
          id="correction-reason"
          labelText={t("corrections.dialog.reason")}
          value={reason}
          onChange={(event) => setReason(event.target.value as Reason | "")}
        >
          <SelectItem value="" text={t("corrections.dialog.chooseReason")} />
          {reasons.map((option) => (
            <SelectItem key={option} value={option} text={t(`corrections.reasons.${option}`)} />
          ))}
        </Select>
        <TextInput
          id="correction-source"
          labelText={t("corrections.dialog.source")}
          helperText={t("corrections.dialog.sourceHelp")}
          maxLength={200}
          value={source}
          onChange={(event) => setSource(event.target.value)}
        />
        <p>{t("corrections.dialog.final")}</p>
      </Stack>
    </Modal>
  );
}
