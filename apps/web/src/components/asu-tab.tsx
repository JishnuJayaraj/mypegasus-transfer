import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import { DocumentReviewReason, QuarantineReason } from "@transfer/domain";
import {
  DOCUMENT_ACCEPT,
  readFileAsBase64,
  SELF_SERVICE_NAMESPACE,
} from "@transfer/self-service-ui";
import {
  Button,
  DateField,
  FileUploaderButton,
  formatDate,
  formatTimestamp,
  InlineNotification,
  parseDisplayDate,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  Stack,
  TextInput,
} from "@transfer/ui";
import { useId, useState, type ChangeEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { participationAsuQuery, useApi } from "../api";
import { documentNavigation } from "./documents-tab";
import { ReloadNotice, useDraft } from "./draft";
import { Kug200bSection } from "./kug200b-section";

// The tab "Arbeitsuche" (process-and-lifecycle.md, Arbeitsuchendmeldung and dates;
// data-protection.md, the ASU record): the route, the knowledge date with the due date or its
// orientation, the registration with its proof ("Meldung erfassen": the date and either a BA
// confirmation linked afterwards or the BA-Kundennummer, masked as typed and never shown back),
// the BA confirmations and the step's missing items. Every button by its capability; the API
// checks each again. Each editor keeps the value or version it was read with (ADR-0010; no silent
// loss): clean, it follows a refresh; dirty, it keeps its input and shows a change from elsewhere
// as a conflict. German only. No reminder is sent from here (Q1, Q152).

type Detail = components["schemas"]["ParticipationDetail"];
type View = components["schemas"]["AsuView"];
type Channel = NonNullable<View["route"]["channel"]>;
type Source = components["schemas"]["AttestationSource"];
type Message = { kind: "success" | "error"; text: string };

const channels: Channel[] = ["kug_200b", "online_self", "in_person"];
const sources: Source[] = [
  "ba_document_inspected",
  "ba_online_account_inspected",
  "ba_confirmed_by_phone",
];

/** A write's answer, or its refusal thrown (the client rejects problems already). */
const ok = <T,>(result: { data?: T; error?: unknown }) => {
  if (result.data === undefined) throw result.error ?? new Error("No answer");
  return result.data;
};

/** A refusal's first code, if the API named one. */
const codeOf = (error: unknown) =>
  error instanceof ApiProblemError ? error.problem.errors?.[0]?.code : undefined;

export function AsuTab({ detail }: { detail: Detail }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const asuQuery = participationAsuQuery(api, detail.id);
  const query = useQuery(asuQuery);
  const [message, setMessage] = useState<Message>();
  const [busy, setBusy] = useState(false);
  const path = { participationId: detail.id };

  if (query.isPending) return <p aria-live="polite">{t("asu.loading")}</p>;
  if (query.isError) {
    return <InlineNotification kind="error" title={t("asu.failed")} hideCloseButton lowContrast />;
  }
  const view = query.data;
  if (!view.applies) return <p>{t("asu.notApplicable")}</p>;

  /** A refusal as the tab's message: its code's text where there is one. */
  function failure(error: unknown): string {
    const code = codeOf(error);
    if (error instanceof ApiProblemError && error.status === 409) return t("asu.messages.conflict");
    if (error instanceof ApiProblemError && error.status === 403)
      return t("asu.messages.forbidden");
    const known = code && t(`asu.messages.codes.${code}` as never, { defaultValue: "" });
    return known || t("asu.messages.failed");
  }

  /** Runs a write; the tab is read again afterwards, whatever happened (capabilities change). */
  async function act(action: () => Promise<unknown>, done = t("asu.messages.saved")) {
    setBusy(true);
    setMessage(undefined);
    try {
      await action();
      setMessage({ kind: "success", text: done });
      return true;
    } catch (error) {
      setMessage({ kind: "error", text: failure(error) });
      return false;
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: asuQuery.queryKey });
    }
  }

  /** Opens a document through the logged opening (a link valid 60 s). */
  async function open(documentId: string) {
    setMessage(undefined);
    try {
      const data = ok(
        await api.POST("/api/v1/participations/{participationId}/documents/{documentId}/opening", {
          params: { path: { ...path, documentId } },
          headers: { "Content-Type": "application/json" },
        }),
      );
      documentNavigation.assign(data.url);
    } catch (error) {
      setMessage({ kind: "error", text: failure(error) });
    }
  }

  return (
    <Stack gap={6}>
      {message && (
        <InlineNotification
          kind={message.kind}
          role={message.kind === "error" ? "alert" : "status"}
          title={message.text}
          onClose={() => setMessage(undefined)}
          lowContrast
        />
      )}
      {view.closed && <p>{t("asu.closed")}</p>}
      <RouteSection
        view={view}
        busy={busy}
        onSave={(channel, version) =>
          act(async () =>
            ok(
              await api.PUT("/api/v1/participations/{participationId}/asu/route", {
                params: { path },
                body: { channel, version },
              }),
            ),
          )
        }
      />
      <KnowledgeSection
        view={view}
        busy={busy}
        onSave={(knowledgeDate, previous) =>
          act(async () =>
            ok(
              await api.PUT("/api/v1/participations/{participationId}/knowledge-date", {
                params: { path },
                body: { knowledgeDate, previous },
              }),
            ),
          )
        }
      />
      <RegistrationSection
        view={view}
        busy={busy}
        onRecord={(body) =>
          act(async () =>
            ok(
              await api.POST("/api/v1/participations/{participationId}/asu/registration", {
                params: { path },
                body,
              }),
            ),
          )
        }
        onConfirm={(confirmedOn) =>
          act(async () =>
            ok(
              await api.POST("/api/v1/participations/{participationId}/asu/confirmation", {
                params: { path },
                body: { registrationId: view.registration!.id, confirmedOn },
              }),
            ),
          )
        }
      />
      <Kug200bSection view={view} busy={busy} act={act} onOpen={open} />
      <ProofSection
        view={view}
        busy={busy}
        onUpload={async (file) => {
          await act(async () => {
            const content = await readFileAsBase64(file);
            ok(
              await api.POST("/api/v1/participations/{participationId}/documents", {
                params: { path },
                body: { type: "asu_proof", fileName: file.name, content },
              }),
            );
          }, t("asu.messages.uploaded"));
        }}
        onOpen={open}
        onReview={(documentId, reasonCode) =>
          act(async () =>
            ok(
              await api.POST(
                "/api/v1/participations/{participationId}/documents/{documentId}/review",
                {
                  params: { path: { ...path, documentId } },
                  body: reasonCode
                    ? { decision: "rejected", reasonCode }
                    : { decision: "accepted" },
                },
              ),
            ),
          )
        }
        onQuarantine={(documentId, reasonCode) =>
          act(
            async () =>
              ok(
                await api.POST(
                  "/api/v1/participations/{participationId}/documents/{documentId}/quarantine",
                  { params: { path: { ...path, documentId } }, body: { reasonCode } },
                ),
              ),
            t("asu.messages.quarantined"),
          )
        }
        onLift={(documentId) =>
          act(
            async () =>
              ok(
                await api.POST(
                  "/api/v1/participations/{participationId}/documents/{documentId}/quarantine-lift",
                  { params: { path: { ...path, documentId } } },
                ),
              ),
            t("asu.messages.lifted"),
          )
        }
        onLink={(documentId) =>
          act(async () =>
            ok(
              await api.POST("/api/v1/participations/{participationId}/asu/proof-link", {
                params: { path },
                body: { registrationId: view.registration!.id, documentId },
              }),
            ),
          )
        }
      />
      <MissingSection view={view} />
    </Stack>
  );
}

/** A labelled region of the tab. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="tp-section" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      <Stack gap={4}>{children}</Stack>
    </section>
  );
}

/** "Weg": the placement Agentur's default preselected, never a blocker (process-and-lifecycle.md, Arbeitsuchendmeldung). */
function RouteSection(props: {
  view: View;
  busy: boolean;
  onSave: (channel: Channel, version: number) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const { route, capabilities } = props.view;
  // The stored route with its version; unset, the editor shows the preselection. A save is
  // followed by the tab's new state (an equal draft is clean again), so it adopts nothing itself.
  const current = { revision: route.version, value: route.channel };
  const { draft, setDraft, conflict, token, adopt } = useDraft<Channel | null>(
    current,
    (a, b) => a === b,
  );
  const shown = draft ?? route.defaultChannel ?? "kug_200b";
  const label = (value: Channel) => t(`asu.channels.${value}`);
  return (
    <Section title={t("asu.route.title")}>
      <p>{route.channel ? label(route.channel) : t("asu.route.none")}</p>
      {capabilities.setRoute ? (
        <>
          {route.channel === null && route.defaultChannel && (
            <p>{t("asu.route.preselected", { channel: label(route.defaultChannel) })}</p>
          )}
          {conflict && <ReloadNotice title={t("draft.conflict")} onReload={() => adopt(current)} />}
          <Select
            id="asu-route"
            labelText={t("asu.route.label")}
            value={shown}
            onChange={(event) => setDraft(event.target.value as Channel)}
          >
            {channels.map((value) => (
              <SelectItem key={value} value={value} text={label(value)} />
            ))}
          </Select>
          <div>
            <Button size="md" disabled={props.busy} onClick={() => void props.onSave(shown, token)}>
              {t("asu.route.save")}
            </Button>
          </div>
        </>
      ) : (
        props.view.registration && <p>{t("asu.route.fixed")}</p>
      )}
    </Section>
  );
}

/**
 * "Bestätigung der Agentur am" for a batch's registration (process-and-lifecycle.md, Kug 200b
 * batches): follow-up work the PL records once; it never conditions the registration.
 */
function Confirmation(props: {
  confirmedOn: string | null;
  may: boolean;
  busy: boolean;
  onConfirm: (confirmedOn: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [date, setDate] = useState("");
  const [invalid, setInvalid] = useState(false);
  if (props.confirmedOn) {
    return <p>{t("asu.confirmation.value", { date: formatDate(props.confirmedOn) })}</p>;
  }
  if (!props.may) return <p>{t("asu.confirmation.missing")}</p>;
  const submit = () => {
    const parsed = parseDisplayDate(date);
    if (!parsed.ok || parsed.value === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    void props.onConfirm(parsed.value);
  };
  return (
    <>
      <DateField
        id="asu-confirmed-on"
        labelText={t("asu.confirmation.label")}
        defaultValue={date}
        onChange={setDate}
        invalidText={invalid ? t("asu.confirmation.invalid") : undefined}
      />
      <div>
        <Button size="md" disabled={props.busy} onClick={submit}>
          {t("asu.confirmation.save")}
        </Button>
      </div>
    </>
  );
}

/** A typed date as the ISO date it names, else the text itself (so "1.1.2026" equals "01.01.2026"). */
const dateKey = (text: string) => {
  const parsed = parseDisplayDate(text);
  return parsed.ok && parsed.value !== undefined ? parsed.value : text.trim();
};

/** "Kenntnisdatum" and the due date: statutory, or an orientation only (process-and-lifecycle.md, dates). */
function KnowledgeSection(props: {
  view: View;
  busy: boolean;
  onSave: (date: string | null, previous: string | null) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const { view } = props;
  const stored = view.knowledgeDate ?? null;
  // The date read is the save's `previous` (409 stale_value when it changed meanwhile).
  const current = { revision: stored, value: stored ? formatDate(stored) : "" };
  const { draft, setDraft, conflict, token, adopt } = useDraft<string, string | null>(
    current,
    (a, b) => dateKey(a) === dateKey(b),
  );
  const [invalid, setInvalid] = useState(false);
  if (view.knowledgeDate === undefined) return null;
  const due = view.dueDate;
  // A save is followed by the tab's new state, which a draft naming the same date equals.
  const save = (date: string | null) => {
    if (date === null) setDraft("");
    void props.onSave(date, token);
  };
  const submit = () => {
    const parsed = parseDisplayDate(draft);
    if (!parsed.ok || parsed.value === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    save(parsed.value);
  };
  return (
    <Section title={t("asu.knowledge.title")}>
      <p>
        {view.oldEmploymentEndDate
          ? t("asu.knowledge.endDate", { date: formatDate(view.oldEmploymentEndDate) })
          : t("asu.knowledge.endDateMissing")}
      </p>
      <p>
        {view.knowledgeDate
          ? t("asu.knowledge.value", { date: formatDate(view.knowledgeDate) })
          : t("asu.knowledge.missing")}
      </p>
      <p data-testid="asu-due">
        {due
          ? due.kind === "statutory"
            ? t(`asu.due.${due.branch}`, { date: formatDate(due.date) })
            : t("asu.due.orientation", { date: formatDate(due.date) })
          : t("asu.due.none")}
      </p>
      {view.capabilities.setKnowledgeDate && (
        <>
          {conflict && <ReloadNotice title={t("draft.conflict")} onReload={() => adopt(current)} />}
          <DateField
            // A new baseline (a refresh of a clean editor, a save, "Neu laden") shows its date.
            key={token ?? ""}
            id="asu-knowledge-date"
            labelText={t("asu.knowledge.label")}
            defaultValue={draft}
            onChange={setDraft}
            invalidText={invalid ? t("asu.knowledge.invalid") : undefined}
          />
          <p className="tp-hint">{t("asu.knowledge.helper")}</p>
          <div className="tp-inline-actions">
            <Button size="md" disabled={props.busy} onClick={submit}>
              {t("asu.knowledge.save")}
            </Button>
            {token && (
              <Button kind="ghost" size="md" disabled={props.busy} onClick={() => save(null)}>
                {t("asu.knowledge.clear")}
              </Button>
            )}
          </div>
        </>
      )}
    </Section>
  );
}

type RegistrationBody = components["schemas"]["AsuRegistrationInput"];

/** "Meldung" and "Meldung erfassen" (process-and-lifecycle.md, Arbeitsuchendmeldung): the date and its proof, the number write-only. */
function RegistrationSection(props: {
  view: View;
  busy: boolean;
  onRecord: (body: RegistrationBody) => Promise<boolean>;
  onConfirm: (confirmedOn: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const { view } = props;
  const { registration, capabilities } = view;
  const [date, setDate] = useState("");
  const [kind, setKind] = useState<"confirmation" | "customer_number">("confirmation");
  const [number, setNumber] = useState("");
  const [source, setSource] = useState<Source>("ba_online_account_inspected");
  const [invalid, setInvalid] = useState(false);
  // The route the recorder reviewed: followed while the form is empty, kept once they type, so a
  // route changed elsewhere meanwhile shows here and its save is refused (409), never frozen.
  const [reviewed, setReviewed] = useState(view.route.version);
  const typing = date !== "" || number !== "";
  if (!typing && reviewed !== view.route.version) setReviewed(view.route.version);
  const routeChanged = typing && reviewed !== view.route.version;

  if (registration) {
    const { proof } = registration;
    return (
      <Section title={t("asu.registration.title")}>
        <p>
          {t("asu.registration.registeredOn", {
            date: formatDate(registration.registeredOn),
            channel: t(`asu.channels.${registration.channel}`),
          })}
        </p>
        <p>
          {proof
            ? t(`asu.registration.proof.${proof.kind}`, {
                source: proof.attestationSource ? t(`asu.sources.${proof.attestationSource}`) : "",
              })
            : t("asu.registration.proofMissing")}
        </p>
        {registration.withProofSince ? (
          <p>
            {t("asu.registration.withProofSince", {
              at: formatTimestamp(registration.withProofSince),
            })}
          </p>
        ) : (
          proof && <p>{t("asu.registration.proofUnusable")}</p>
        )}
        {registration.channel === "kug_200b" && (
          <Confirmation
            confirmedOn={registration.confirmedOn}
            may={capabilities.recordConfirmation}
            busy={props.busy}
            onConfirm={props.onConfirm}
          />
        )}
      </Section>
    );
  }
  const record = async () => {
    const parsed = parseDisplayDate(date);
    if (!parsed.ok || parsed.value === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const done = await props.onRecord({
      registeredOn: parsed.value,
      routeVersion: reviewed,
      ...(kind === "customer_number" && { attestation: { customerNumber: number, source } }),
    });
    // The number is never kept in the page once sent.
    if (done) setNumber("");
  };
  return (
    <Section title={t("asu.registration.title")}>
      <p>{t("asu.registration.none")}</p>
      {view.route.channel === "kug_200b" && <p>{t("asu.registration.kugHint")}</p>}
      {capabilities.recordRegistration && (
        <fieldset className="tp-fieldset">
          <legend>{t("asu.registration.record")}</legend>
          <Stack gap={5}>
            {routeChanged && (
              <ReloadNotice
                title={t("asu.registration.routeChanged", {
                  channel: view.route.channel ? t(`asu.channels.${view.route.channel}`) : "",
                })}
                action={t("asu.registration.adoptRoute")}
                onReload={() => setReviewed(view.route.version)}
              />
            )}
            <DateField
              id="asu-registered-on"
              labelText={t("asu.registration.date")}
              onChange={setDate}
              invalidText={invalid ? t("asu.knowledge.invalid") : undefined}
            />
            <RadioButtonGroup
              legendText={t("asu.registration.proofKind")}
              name="asu-proof-kind"
              valueSelected={kind}
              onChange={(value) => setKind(value as typeof kind)}
            >
              <RadioButton
                id="asu-proof-confirmation"
                value="confirmation"
                labelText={t("asu.registration.kindConfirmation")}
              />
              {capabilities.attest && (
                <RadioButton
                  id="asu-proof-customer-number"
                  value="customer_number"
                  labelText={t("asu.registration.kindCustomerNumber")}
                />
              )}
            </RadioButtonGroup>
            {kind === "customer_number" && (
              <>
                <TextInput
                  id="asu-customer-number"
                  type="password"
                  autoComplete="off"
                  labelText={t("asu.registration.customerNumber")}
                  helperText={t("asu.registration.customerNumberHelper")}
                  value={number}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setNumber(event.target.value)}
                />
                <Select
                  id="asu-attestation-source"
                  labelText={t("asu.registration.source")}
                  value={source}
                  onChange={(event) => setSource(event.target.value as Source)}
                >
                  {sources.map((value) => (
                    <SelectItem key={value} value={value} text={t(`asu.sources.${value}`)} />
                  ))}
                </Select>
              </>
            )}
            <div>
              <Button size="md" disabled={props.busy} onClick={() => void record()}>
                {t("asu.registration.save")}
              </Button>
            </div>
          </Stack>
        </fieldset>
      )}
    </Section>
  );
}

/** "BA-Bestätigungen": upload, the consultant's review and link; the PL sees metadata only. */
function ProofSection(props: {
  view: View;
  busy: boolean;
  onUpload: (file: File) => unknown;
  onOpen: (documentId: string) => unknown;
  onReview: (documentId: string, reasonCode?: DocumentReviewReason) => unknown;
  onQuarantine: (documentId: string, reasonCode: QuarantineReason) => unknown;
  onLift: (documentId: string) => unknown;
  onLink: (documentId: string) => unknown;
}) {
  const { t } = useTranslation();
  const { t: ts } = useTranslation(SELF_SERVICE_NAMESPACE);
  const { view } = props;
  const [reason, setReason] = useState<DocumentReviewReason>("unreadable");
  const [suspicion, setSuspicion] = useState<QuarantineReason>("suspected_wrong_person");
  // Back office reads the registration's summary only, never the documents.
  if (view.proofDocuments === undefined) return null;
  return (
    <Section title={t("asu.proofs.title")}>
      {view.proofDocuments.length === 0 && <p>{t("asu.proofs.empty")}</p>}
      <ul className="tp-list">
        {view.proofDocuments.map((proof) => {
          const { capabilities: can } = proof;
          const linkable =
            view.capabilities.linkProof &&
            proof.review.state === "accepted" &&
            proof.quarantine === null;
          return (
            <li key={proof.documentId}>
              <Stack gap={3}>
                <span>
                  {[
                    t("asu.proofs.added", { at: formatTimestamp(proof.addedAt) }),
                    proof.quarantine
                      ? t("asu.proofs.quarantined", {
                          reason: t(`asu.proofs.quarantineReasons.${proof.quarantine.reasonCode}`),
                        })
                      : ts(`documents.states.${proof.review.state}`),
                    ...(proof.linked ? [t("asu.proofs.linked")] : []),
                  ].join(" – ")}
                </span>
                <span className="tp-inline-actions">
                  {can.open && (
                    <Button
                      kind="ghost"
                      size="sm"
                      onClick={() => void props.onOpen(proof.documentId)}
                    >
                      {t("asu.proofs.open")}
                    </Button>
                  )}
                  {can.review && (
                    <>
                      <Button
                        kind="ghost"
                        size="sm"
                        disabled={props.busy}
                        onClick={() => void props.onReview(proof.documentId)}
                      >
                        {t("asu.proofs.accept")}
                      </Button>
                      <Select
                        id={`asu-reject-reason-${proof.documentId}`}
                        labelText={t("asu.proofs.rejectReason")}
                        size="sm"
                        value={reason}
                        onChange={(event) => setReason(event.target.value as DocumentReviewReason)}
                      >
                        {DocumentReviewReason.options.map((value) => (
                          <SelectItem
                            key={value}
                            value={value}
                            text={ts(`documents.reasons.${value}`)}
                          />
                        ))}
                      </Select>
                      <Button
                        kind="danger--ghost"
                        size="sm"
                        disabled={props.busy}
                        onClick={() => void props.onReview(proof.documentId, reason)}
                      >
                        {t("asu.proofs.reject")}
                      </Button>
                    </>
                  )}
                  {can.quarantine && (
                    <>
                      <Select
                        id={`asu-quarantine-reason-${proof.documentId}`}
                        labelText={t("asu.proofs.quarantineReason")}
                        size="sm"
                        value={suspicion}
                        onChange={(event) => setSuspicion(event.target.value as QuarantineReason)}
                      >
                        {QuarantineReason.options.map((value) => (
                          <SelectItem
                            key={value}
                            value={value}
                            text={t(`asu.proofs.quarantineReasons.${value}`)}
                          />
                        ))}
                      </Select>
                      <Button
                        kind="danger--ghost"
                        size="sm"
                        disabled={props.busy}
                        onClick={() => void props.onQuarantine(proof.documentId, suspicion)}
                      >
                        {t("asu.proofs.quarantine")}
                      </Button>
                    </>
                  )}
                  {can.liftQuarantine && (
                    <Button
                      kind="ghost"
                      size="sm"
                      disabled={props.busy}
                      onClick={() => void props.onLift(proof.documentId)}
                    >
                      {t("asu.proofs.lift")}
                    </Button>
                  )}
                  {linkable && !proof.linked && (
                    <Button
                      kind="tertiary"
                      size="sm"
                      disabled={props.busy}
                      onClick={() => void props.onLink(proof.documentId)}
                    >
                      {t("asu.proofs.link")}
                    </Button>
                  )}
                </span>
              </Stack>
            </li>
          );
        })}
      </ul>
      {view.capabilities.linkProof && <p className="tp-hint">{t("asu.proofs.linkHint")}</p>}
      {view.proofDocuments.some((proof) => proof.capabilities.quarantine) && (
        <p className="tp-hint">{t("asu.proofs.quarantineHint")}</p>
      )}
      {view.capabilities.addProof && (
        <div>
          <FileUploaderButton
            id="asu-proof-file"
            labelText={t("asu.proofs.upload")}
            accept={DOCUMENT_ACCEPT}
            buttonKind="tertiary"
            size="md"
            disabled={props.busy}
            disableLabelChanges
            multiple={false}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              const file = event.target.files?.[0];
              if (file) void props.onUpload(file);
            }}
          />
        </div>
      )}
    </Section>
  );
}

/** The step `asu_registration`'s missing items, keys only (the Kug 200b ones on its route). */
function MissingSection({ view }: { view: View }) {
  const { t } = useTranslation();
  if (view.closed) return null;
  return (
    <Section title={t("asu.missing.title")}>
      {view.missing.length === 0 ? (
        <p>{t("asu.missing.none")}</p>
      ) : (
        <ul className="tp-list">
          {view.missing.map((item) => (
            <li key={item.ruleId}>
              {t(`asu.missing.keys.${item.key}` as never, { defaultValue: item.key })}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
