import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import { DocumentReviewReason } from "@transfer/domain";
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

// The tab "Arbeitsuche" (process-and-lifecycle.md, Arbeitsuchendmeldung and dates;
// data-protection.md, the ASU record): the route, the knowledge date with the due date or its
// orientation, the registration with its proof ("Meldung erfassen": the date and either a BA
// confirmation linked afterwards or the BA-Kundennummer, masked as typed and never shown back),
// the BA confirmations and the step's missing items. Every button by its capability; the API
// checks each again. German only. No reminder is sent from here (Q1, Q152).

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
  const ok = <T,>(result: { data?: T; error?: unknown }) => {
    if (result.data === undefined) throw result.error ?? new Error("No answer");
    return result.data;
  };

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
        onSave={(channel) =>
          act(async () =>
            ok(
              await api.PUT("/api/v1/participations/{participationId}/asu/route", {
                params: { path },
                body: { channel, version: view.route.version },
              }),
            ),
          )
        }
      />
      <KnowledgeSection
        view={view}
        busy={busy}
        onSave={(knowledgeDate) =>
          act(async () =>
            ok(
              await api.PUT("/api/v1/participations/{participationId}/knowledge-date", {
                params: { path },
                body: { knowledgeDate, previous: view.knowledgeDate ?? null },
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
      />
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
        onOpen={async (documentId) => {
          setMessage(undefined);
          try {
            const data = ok(
              await api.POST(
                "/api/v1/participations/{participationId}/documents/{documentId}/opening",
                {
                  params: { path: { ...path, documentId } },
                  headers: { "Content-Type": "application/json" },
                },
              ),
            );
            documentNavigation.assign(data.url);
          } catch (error) {
            setMessage({ kind: "error", text: failure(error) });
          }
        }}
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

/** "Weg": the placement Agentur's default preselected, never a blocker (D19). */
function RouteSection(props: { view: View; busy: boolean; onSave: (channel: Channel) => unknown }) {
  const { t } = useTranslation();
  const { route, capabilities } = props.view;
  const [channel, setChannel] = useState<Channel>(
    route.channel ?? route.defaultChannel ?? "kug_200b",
  );
  const label = (value: Channel) => t(`asu.channels.${value}`);
  return (
    <Section title={t("asu.route.title")}>
      <p>{route.channel ? label(route.channel) : t("asu.route.none")}</p>
      {capabilities.setRoute ? (
        <>
          {route.channel === null && route.defaultChannel && (
            <p>{t("asu.route.preselected", { channel: label(route.defaultChannel) })}</p>
          )}
          <Select
            id="asu-route"
            labelText={t("asu.route.label")}
            value={channel}
            onChange={(event) => setChannel(event.target.value as Channel)}
          >
            {channels.map((value) => (
              <SelectItem key={value} value={value} text={label(value)} />
            ))}
          </Select>
          <div>
            <Button size="md" disabled={props.busy} onClick={() => void props.onSave(channel)}>
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

/** "Kenntnisdatum" and the due date: statutory, or an orientation only (D22). */
function KnowledgeSection(props: {
  view: View;
  busy: boolean;
  onSave: (date: string | null) => unknown;
}) {
  const { t } = useTranslation();
  const { view } = props;
  const [text, setText] = useState(view.knowledgeDate ? formatDate(view.knowledgeDate) : "");
  const [invalid, setInvalid] = useState(false);
  if (view.knowledgeDate === undefined) return null;
  const due = view.dueDate;
  const save = () => {
    const parsed = parseDisplayDate(text);
    if (!parsed.ok || parsed.value === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    void props.onSave(parsed.value);
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
          <DateField
            id="asu-knowledge-date"
            labelText={t("asu.knowledge.label")}
            defaultValue={text}
            onChange={setText}
            invalidText={invalid ? t("asu.knowledge.invalid") : undefined}
          />
          <p className="tp-hint">{t("asu.knowledge.helper")}</p>
          <div className="tp-inline-actions">
            <Button size="md" disabled={props.busy} onClick={save}>
              {t("asu.knowledge.save")}
            </Button>
            {view.knowledgeDate && (
              <Button
                kind="ghost"
                size="md"
                disabled={props.busy}
                onClick={() => void props.onSave(null)}
              >
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

/** "Meldung" and "Meldung erfassen" (D19): the date and its proof, the number write-only. */
function RegistrationSection(props: {
  view: View;
  busy: boolean;
  onRecord: (body: RegistrationBody) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const { view } = props;
  const { registration, capabilities } = view;
  const [date, setDate] = useState("");
  const [kind, setKind] = useState<"confirmation" | "customer_number">("confirmation");
  const [number, setNumber] = useState("");
  const [source, setSource] = useState<Source>("ba_online_account_inspected");
  const [invalid, setInvalid] = useState(false);

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
  onLink: (documentId: string) => unknown;
}) {
  const { t } = useTranslation();
  const { t: ts } = useTranslation(SELF_SERVICE_NAMESPACE);
  const { view } = props;
  const [reason, setReason] = useState<DocumentReviewReason>("unreadable");
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
                  {t("asu.proofs.added", { at: formatTimestamp(proof.addedAt) })} –{" "}
                  {proof.quarantine
                    ? t("asu.proofs.quarantined")
                    : ts(`documents.states.${proof.review.state}`)}
                  {proof.linked && ` – ${t("asu.proofs.linked")}`}
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
