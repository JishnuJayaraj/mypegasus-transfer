import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import { DOCUMENT_ACCEPT, readFileAsBase64 } from "@transfer/self-service-ui";
import {
  Button,
  Checkbox,
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
  SimpleTable,
  Stack,
  TextInput,
  useToast,
} from "@transfer/ui";
import { useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { participationProfilingQuery, participationQuery, useApi } from "../api";
import { documentNavigation } from "./documents-tab";

// The signed TL 407 on the section "Profilingbogen (TL 407)" (data-protection.md, signed scans,
// signed declarations and quarantine; process-and-lifecycle.md, profiling track): "Unterschriebenen
// Bogen hochladen" from a generated form or as external paper, "Prüfen" with the actual signature
// dates, the confirmations and the declarations as marked, "Ablehnen", "Löschen" before the review,
// "Unter Quarantäne stellen" and "Quarantäne aufheben", and "Profiling abschließen" with its date.
// Every button follows the API's capabilities; the API checks each action again. German only.

type View = components["schemas"]["Profiling"];
type Scan = components["schemas"]["Tl407Scan"];
type Choice = "full" | "anonymous_callme" | "anonymous_no_contact" | "none";
type Done = "uploaded" | "accepted" | "rejected" | "deleted" | "quarantined" | "lifted";
type Dialog =
  | { kind: "review" | "reject" | "quarantine" | "delete"; scan: Scan }
  | { kind: "none" };

const choices = ["full", "anonymous_callme", "anonymous_no_contact", "none"] as const;
const external = "external_paper";

/** A refusal as the section's message: the first code the API named, else a failure kind. */
function messageOf(error: unknown): string {
  if (!(error instanceof ApiProblemError)) return "failed";
  const code = error.problem.errors?.[0]?.code;
  if (error.status === 409) return "stale";
  if (error.status === 422 && code) return `codes.${code}`;
  return error.status === 403 ? "forbidden" : "failed";
}

export function SignedScans({ view }: { view: View }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [message, setMessage] = useState<string>();
  const participationId = view.participationId;
  const path = { participationId };

  /** Runs an action; afterwards the tab and the participation are read again. */
  const act = useMutation({
    mutationFn: async ({ run }: { run: () => Promise<unknown>; done: Done }) => run(),
    onSuccess: (_, { done }) => {
      setMessage(undefined);
      showToast({ title: t(`profiling.scans.done.${done}`) });
    },
    onError: (error) => setMessage(messageOf(error)),
    onSettled: async () => {
      setDialog({ kind: "none" });
      await queryClient.invalidateQueries({
        queryKey: participationProfilingQuery(api, participationId).queryKey,
      });
      await queryClient.invalidateQueries({
        queryKey: participationQuery(api, participationId).queryKey,
      });
    },
  });
  const run = (done: Done, call: () => Promise<{ error?: unknown; response: Response }>) =>
    act.mutate({
      done,
      run: async () => {
        const { error } = await call();
        if (error) throw error;
      },
    });
  const documentPath = (scan: Scan) => ({ ...path, documentId: scan.documentId });

  async function open(scan: Scan) {
    setMessage(undefined);
    try {
      const { data } = await api.POST(
        "/api/v1/participations/{participationId}/documents/{documentId}/opening",
        {
          params: { path: documentPath(scan) },
          headers: { "Content-Type": "application/json" },
        },
      );
      if (!data) throw new Error("No opening");
      documentNavigation.assign(data.url);
    } catch (error) {
      setMessage(messageOf(error));
    }
  }

  const generatedOn = (documentId: string | null) => {
    const form = view.tl407Forms.find((each) => each.documentId === documentId);
    return form ? formatTimestamp(form.generatedAt) : "";
  };
  const stateOf = (scan: Scan) => {
    if (scan.quarantine) {
      return t("profiling.scans.states.quarantined", {
        reason: t(`profiling.scans.quarantineReasons.${scan.quarantine.reasonCode}`),
      });
    }
    const { state, reasonCode } = scan.review;
    return reasonCode
      ? t("profiling.scans.states.rejected", {
          reason: t(`profiling.scans.rejectReasons.${reasonCode}`),
        })
      : t(`profiling.scans.states.${state}`);
  };
  const action = (scan: Scan, kind: Exclude<Dialog["kind"], "none">, label: string) => (
    <Button
      kind={kind === "delete" ? "danger--ghost" : "ghost"}
      size="sm"
      disabled={act.isPending}
      aria-label={`${label}: ${formatTimestamp(scan.addedAt)}`}
      onClick={() => setDialog({ kind, scan })}
    >
      {label}
    </Button>
  );

  return (
    <Stack gap={5}>
      {message && (
        <InlineNotification
          kind="error"
          role="alert"
          title={t(`profiling.scans.messages.${message}`, {
            defaultValue: t("profiling.scans.messages.failed"),
          })}
          onClose={() => setMessage(undefined)}
          lowContrast
        />
      )}
      <SimpleTable
        title={t("profiling.scans.title")}
        columns={(["addedAt", "origin", "version", "signedOn", "state", "actions"] as const).map(
          (key) => ({ key, header: t(`profiling.scans.columns.${key}`) }),
        )}
        rows={view.tl407Scans.map((scan) => ({
          id: scan.documentId,
          addedAt: formatTimestamp(scan.addedAt),
          origin:
            scan.origin === external
              ? t("profiling.scans.external")
              : t("profiling.scans.fromForm", { at: generatedOn(scan.generationDocumentId) }),
          version: scan.formVersion?.replace("-", "/") ?? "—",
          signedOn: scan.participantSignedOn
            ? t("profiling.scans.signedBy", {
                participant: formatDate(scan.participantSignedOn),
                profiler: formatDate(scan.profilerSignedOn),
              })
            : "—",
          state: stateOf(scan),
          actions: (
            <span className="tp-inline-actions">
              {scan.capabilities.open && (
                <Button
                  kind="ghost"
                  size="sm"
                  aria-label={`${t("profiling.scans.open")}: ${formatTimestamp(scan.addedAt)}`}
                  onClick={() => void open(scan)}
                >
                  {t("profiling.scans.open")}
                </Button>
              )}
              {scan.capabilities.review && action(scan, "review", t("profiling.scans.review"))}
              {scan.capabilities.review && action(scan, "reject", t("profiling.scans.reject"))}
              {scan.capabilities.delete && action(scan, "delete", t("profiling.scans.delete"))}
              {scan.capabilities.quarantine &&
                action(scan, "quarantine", t("profiling.scans.quarantine"))}
              {scan.capabilities.liftQuarantine && (
                <Button
                  kind="ghost"
                  size="sm"
                  disabled={act.isPending}
                  onClick={() =>
                    run("lifted", () =>
                      api.POST(
                        "/api/v1/participations/{participationId}/documents/{documentId}/quarantine-lift",
                        {
                          params: { path: documentPath(scan) },
                          headers: { "Content-Type": "application/json" },
                        },
                      ),
                    )
                  }
                >
                  {t("profiling.scans.lift")}
                </Button>
              )}
            </span>
          ),
        }))}
        emptyState={t("profiling.scans.empty")}
      />
      {view.capabilities.addTl407Scan && (
        <UploadScan
          view={view}
          busy={act.isPending}
          onUpload={(origin, file) =>
            act.mutate({
              done: "uploaded",
              run: async () => {
                const { error } = await api.POST(
                  "/api/v1/participations/{participationId}/documents",
                  {
                    params: { path },
                    body: {
                      type: "tl407_signed_scan",
                      fileName: file.name,
                      content: await readFileAsBase64(file),
                      ...(origin === external
                        ? { origin: external }
                        : { origin: "generated", generationDocumentId: origin }),
                    },
                  },
                );
                if (error) throw error;
              },
            })
          }
        />
      )}
      <ReviewDialog
        view={view}
        scan={dialog.kind === "review" ? dialog.scan : undefined}
        busy={act.isPending}
        onClose={() => setDialog({ kind: "none" })}
        onAccept={(scan, review) =>
          run("accepted", () =>
            api.POST("/api/v1/participations/{participationId}/documents/{documentId}/review", {
              params: { path: documentPath(scan) },
              body: { decision: "accepted", scan: review },
            }),
          )
        }
      />
      <ReasonDialog
        dialog={dialog}
        busy={act.isPending}
        onClose={() => setDialog({ kind: "none" })}
        onConfirm={(scan, kind, reason) => {
          const params = { path: documentPath(scan) };
          if (kind === "reject") {
            run("rejected", () =>
              api.POST("/api/v1/participations/{participationId}/documents/{documentId}/review", {
                params,
                body: { decision: "rejected", reasonCode: reason as "incomplete" },
              }),
            );
          } else if (kind === "quarantine") {
            run("quarantined", () =>
              api.POST(
                "/api/v1/participations/{participationId}/documents/{documentId}/quarantine",
                { params, body: { reasonCode: reason as "suspected_wrong_person" } },
              ),
            );
          } else {
            run("deleted", () =>
              api.DELETE("/api/v1/participations/{participationId}/documents/{documentId}", {
                params: { ...params, query: { reasonCode: reason as "wrong_person" } },
              }),
            );
          }
        }}
      />
      <CompleteProfiling view={view} />
    </Stack>
  );
}

/** "Unterschriebenen Bogen hochladen": the generated form it was printed from, or external paper. */
function UploadScan(props: {
  view: View;
  busy: boolean;
  onUpload: (origin: string, file: File) => void;
}) {
  const { t } = useTranslation();
  const [origin, setOrigin] = useState(props.view.tl407Forms[0]?.documentId ?? external);
  return (
    <fieldset className="tp-fieldset">
      <legend>{t("profiling.scans.upload")}</legend>
      <Stack gap={5}>
        <Select
          id="tl407-scan-origin"
          labelText={t("profiling.scans.origin")}
          value={origin}
          onChange={(event) => setOrigin(event.target.value)}
        >
          {props.view.tl407Forms.map((form) => (
            <SelectItem
              key={form.documentId}
              value={form.documentId}
              text={t("profiling.scans.fromForm", { at: formatTimestamp(form.generatedAt) })}
            />
          ))}
          <SelectItem value={external} text={t("profiling.scans.external")} />
        </Select>
        {origin === external && <p className="tp-hint">{t("profiling.scans.externalHint")}</p>}
        <div>
          <FileUploaderButton
            id="tl407-scan-file"
            labelText={t("profiling.scans.file")}
            accept={DOCUMENT_ACCEPT}
            buttonKind="tertiary"
            size="md"
            disabled={props.busy}
            disableLabelChanges
            multiple={false}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              const file = event.target.files?.[0];
              if (file) props.onUpload(origin, file);
            }}
          />
        </div>
      </Stack>
    </fieldset>
  );
}

type Review = components["schemas"]["ScanReview"];

/**
 * "Prüfen": the actual signature dates, both confirmations, external paper's version and the
 * declarations: as printed (a generated form) or as marked on the paper.
 */
function ReviewDialog(props: {
  view: View;
  scan: Scan | undefined;
  busy: boolean;
  onClose: () => void;
  onAccept: (scan: Scan, review: Review) => void;
}) {
  const { t } = useTranslation();
  const { scan } = props;
  const isExternal = scan?.origin === external;
  const [dates, setDates] = useState({ participant: "", profiler: "" });
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [version, setVersion] = useState(props.view.tl407Versions[0] ?? "");
  const [asPrinted, setAsPrinted] = useState(true);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [contact, setContact] = useState<boolean | null>(null);
  const participant = parseDisplayDate(dates.participant);
  const profiler = parseDisplayDate(dates.profiler);
  const marked = isExternal || !asPrinted;
  const complete =
    participant.ok &&
    participant.value !== undefined &&
    profiler.ok &&
    profiler.value !== undefined &&
    confirmed.length === 2 &&
    (!isExternal || version !== "");
  const close = () => {
    setDates({ participant: "", profiler: "" });
    setConfirmed([]);
    setAsPrinted(true);
    setChoice(null);
    setContact(null);
    props.onClose();
  };
  const date = (key: "participant" | "profiler", ok: boolean) => (
    <TextInput
      id={`tl407-review-${key}`}
      labelText={t(`profiling.scans.reviewDialog.${key}SignedOn`)}
      placeholder="TT.MM.JJJJ"
      value={dates[key]}
      invalid={!ok}
      invalidText={t("profiling.scans.reviewDialog.dateInvalid")}
      onChange={(event) => setDates({ ...dates, [key]: event.target.value })}
    />
  );
  return (
    <Modal
      open={scan !== undefined}
      modalHeading={t("profiling.scans.reviewDialog.title")}
      primaryButtonText={t("profiling.scans.reviewDialog.accept")}
      secondaryButtonText={t("profiling.scans.cancel")}
      primaryButtonDisabled={!complete || props.busy}
      onRequestClose={close}
      onRequestSubmit={() => {
        if (!scan || !complete) return;
        props.onAccept(scan, {
          participantSignedOn: participant.value!,
          profilerSignedOn: profiler.value!,
          confirmations: confirmed as Review["confirmations"],
          ...(isExternal && { formVersion: version }),
          declarations: marked
            ? { kind: "as_marked", jobboerseChoice: choice, baContactConsent: contact }
            : { kind: "as_printed" },
        });
        close();
      }}
    >
      <Stack gap={5}>
        <p>{t("profiling.scans.reviewDialog.intro")}</p>
        {date("participant", participant.ok)}
        {date("profiler", profiler.ok)}
        {(["signatures_present", "all_pages_present"] as const).map((code) => (
          <Checkbox
            key={code}
            id={`tl407-review-${code}`}
            labelText={t(`profiling.scans.reviewDialog.${code}`)}
            checked={confirmed.includes(code)}
            onChange={(_, { checked }) =>
              setConfirmed(checked ? [...confirmed, code] : confirmed.filter((c) => c !== code))
            }
          />
        ))}
        {isExternal && (
          <Select
            id="tl407-review-version"
            labelText={t("profiling.scans.reviewDialog.version")}
            value={version}
            onChange={(event) => setVersion(event.target.value)}
          >
            {props.view.tl407Versions.map((each) => (
              <SelectItem key={each} value={each} text={each.replace("-", "/")} />
            ))}
          </Select>
        )}
        {!isExternal && (
          <RadioButtonGroup
            name="tl407-review-declarations"
            legendText={t("profiling.scans.reviewDialog.declarations")}
            valueSelected={asPrinted ? "printed" : "marked"}
            onChange={(value) => setAsPrinted(value === "printed")}
          >
            {(["printed", "marked"] as const).map((value) => (
              <RadioButton
                key={value}
                id={`tl407-review-declarations-${value}`}
                value={value}
                labelText={t(`profiling.scans.reviewDialog.${value}`)}
              />
            ))}
          </RadioButtonGroup>
        )}
        {marked && (
          <>
            <Select
              id="tl407-review-jobboerse"
              labelText={t("profiling.declarations.jobboerse")}
              value={choice ?? "open"}
              onChange={(event) =>
                setChoice(event.target.value === "open" ? null : (event.target.value as Choice))
              }
            >
              <SelectItem value="open" text={t("profiling.scans.reviewDialog.notMarked")} />
              {choices.map((value) => (
                <SelectItem
                  key={value}
                  value={value}
                  text={t(`profiling.declarations.jobboerseOptions.${value}`)}
                />
              ))}
            </Select>
            <RadioButtonGroup
              name="tl407-review-ba-contact"
              legendText={t("profiling.declarations.baContact")}
              orientation="horizontal"
              valueSelected={contact === null ? "open" : contact ? "yes" : "no"}
              onChange={(value) => setContact(value === "open" ? null : value === "yes")}
            >
              {(["yes", "no", "open"] as const).map((value) => (
                <RadioButton
                  key={value}
                  id={`tl407-review-ba-contact-${value}`}
                  value={value}
                  labelText={
                    value === "open"
                      ? t("profiling.scans.reviewDialog.notMarked")
                      : t(`profiling.declarations.baContactOptions.${value}`)
                  }
                />
              ))}
            </RadioButtonGroup>
          </>
        )}
      </Stack>
    </Modal>
  );
}

const reasons = {
  reject: ["unreadable", "wrong_document", "incomplete"],
  quarantine: ["suspected_wrong_person", "suspected_wrong_acceptance"],
  delete: ["wrong_person", "wrong_file"],
} as const;

/** "Ablehnen", "Unter Quarantäne stellen" and "Löschen": each with its closed reason. */
function ReasonDialog(props: {
  dialog: Dialog;
  busy: boolean;
  onClose: () => void;
  onConfirm: (scan: Scan, kind: keyof typeof reasons, reason: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const { dialog } = props;
  const reasonLabel = (kind: keyof typeof reasons, option: string) =>
    kind === "reject"
      ? t(`profiling.scans.rejectReasons.${option as (typeof reasons)["reject"][number]}`)
      : kind === "quarantine"
        ? t(`profiling.scans.quarantineReasons.${option as (typeof reasons)["quarantine"][number]}`)
        : t(`profiling.scans.deleteReasons.${option as (typeof reasons)["delete"][number]}`);
  const kind = dialog.kind === "none" || dialog.kind === "review" ? undefined : dialog.kind;
  const close = () => {
    setReason("");
    props.onClose();
  };
  return (
    <Modal
      open={kind !== undefined}
      danger={kind === "delete"}
      size="sm"
      modalHeading={kind ? t(`profiling.scans.${kind}Title`) : ""}
      primaryButtonText={kind ? t(`profiling.scans.${kind}`) : ""}
      secondaryButtonText={t("profiling.scans.cancel")}
      primaryButtonDisabled={reason === "" || props.busy}
      onRequestClose={close}
      onRequestSubmit={() => {
        if (!kind || dialog.kind === "none" || reason === "") return;
        props.onConfirm(dialog.scan, kind, reason);
        setReason("");
      }}
    >
      {kind && (
        <Stack gap={5}>
          <p>{t(`profiling.scans.${kind}Text`)}</p>
          <Select
            id={`tl407-scan-${kind}-reason`}
            labelText={t("profiling.scans.reason")}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          >
            <SelectItem value="" text={t("profiling.scans.chooseReason")} />
            {reasons[kind].map((option) => (
              <SelectItem key={option} value={option} text={reasonLabel(kind, option)} />
            ))}
          </Select>
        </Stack>
      )}
    </Modal>
  );
}

/**
 * "Profiling abschließen" (Q191): `profilingDoneOn`, by default the later actual signature date of
 * the signed TL 407, never before it and never in the future; the status service decides again.
 */
function CompleteProfiling({ view }: { view: View }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const step = view.transitions.find((each) => each.to === "profiling_done");
  const [text, setText] = useState(formatDate(view.tl407SignedOn));
  const [failure, setFailure] = useState<string>();
  const parsed = parseDisplayDate(text);
  const complete = useMutation({
    mutationFn: async (effectiveDate: string) => {
      const { data, error } = await api.POST(
        "/api/v1/participations/{participationId}/profiling-status",
        {
          params: { path: { participationId: view.participationId } },
          body: { to: "profiling_done", effectiveDate, statusVersion: view.statusVersion },
        },
      );
      if (error) throw error;
      return data;
    },
    onSuccess: async (updated) => {
      setFailure(undefined);
      queryClient.setQueryData(
        participationProfilingQuery(api, view.participationId).queryKey,
        updated,
      );
      await queryClient.invalidateQueries({
        queryKey: participationQuery(api, view.participationId).queryKey,
      });
    },
    onError: (error) => setFailure(messageOf(error)),
  });
  if (!step) return null;
  if (!step.allowed) {
    return step.refusal === "tl407_signed" ? (
      <p className="tp-hint">{t("profiling.scans.completeWaits")}</p>
    ) : null;
  }
  return (
    <fieldset className="tp-fieldset">
      <legend>{t("profiling.scans.complete")}</legend>
      <Stack gap={5}>
        {failure && (
          <InlineNotification
            kind="error"
            title={t(`profiling.scans.messages.${failure}`, {
              defaultValue: t("profiling.scans.messages.failed"),
            })}
            hideCloseButton
            lowContrast
          />
        )}
        <p className="tp-hint">{t("profiling.scans.completeHint")}</p>
        <TextInput
          id="tl407-profiling-done-on"
          labelText={t("profiling.scans.completeDate")}
          placeholder="TT.MM.JJJJ"
          value={text}
          invalid={!parsed.ok}
          invalidText={t("profiling.scans.reviewDialog.dateInvalid")}
          onChange={(event) => setText(event.target.value)}
        />
        <div>
          <Button
            disabled={!parsed.ok || parsed.value === undefined || complete.isPending}
            onClick={() => parsed.ok && parsed.value && complete.mutate(parsed.value)}
          >
            {t("profiling.scans.complete")}
          </Button>
        </div>
      </Stack>
    </fieldset>
  );
}
