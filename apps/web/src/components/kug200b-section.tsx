import { type components } from "@transfer/api-client";
import { DOCUMENT_ACCEPT, readFileAsBase64 } from "@transfer/self-service-ui";
import {
  Button,
  Checkbox,
  DateField,
  FileUploaderButton,
  formatDate,
  formatTimestamp,
  Modal,
  parseDisplayDate,
  Select,
  SelectItem,
  SimpleTable,
  Stack,
} from "@transfer/ui";
import { useId, useState, type ChangeEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "../api";

// The Kug 200b on the tab "Arbeitsuche" (process-and-lifecycle.md, the Kug 200b offer;
// data-protection.md, generated forms and signed scans; Q179, Q184, Q185, Q197): "Kug 200b
// erzeugen" with the handwriting checklist shown before printing, the generated forms ("Öffnen"),
// the signed scans ("Prüfen" with "16 und 17 angekreuzt, Pflichtangaben ausgefüllt,
// unterschrieben"), "Abgelehnt" with its date, and "Erklärung zum Profilzugriff" with a withdrawal
// and "BA informiert am". Every button follows the API's capabilities; the API checks each again.
// German only. The participant ticks, writes and signs on paper: nothing here pre-ticks or signs.

type View = components["schemas"]["AsuView"];
type Offer = components["schemas"]["Kug200bOffer"];
type Scan = components["schemas"]["Kug200bScan"];
type Checklist = components["schemas"]["Kug200bChecklistItem"][];
type Confirmation = components["schemas"]["Kug200bScanConfirmation"];

const external = "external_paper";
const confirmations: Confirmation[] = [
  "declarations_ticked",
  "mandatory_completed",
  "signature_present",
];
const reasons = {
  reject: ["unreadable", "wrong_document", "incomplete"],
  quarantine: ["suspected_wrong_person", "suspected_wrong_acceptance"],
  delete: ["wrong_person", "wrong_file"],
} as const;
type ReasonKind = keyof typeof reasons;

/** A write's answer, or its refusal thrown. */
const ok = <T,>(result: { data?: T; error?: unknown }) => {
  if (result.data === undefined) throw result.error ?? new Error("No answer");
  return result.data;
};

export function Kug200bSection(props: {
  view: View;
  busy: boolean;
  /** Runs a write with the tab's messages; the tab is read again afterwards. */
  act: (action: () => Promise<unknown>, done?: string) => Promise<boolean>;
  onOpen: (documentId: string) => unknown;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const { view, busy, act } = props;
  const offer = view.kug200b;
  const path = { participationId: view.participationId };
  const [generated, setGenerated] = useState<Checklist>();
  const [reviewing, setReviewing] = useState<Scan>();
  const [reasoned, setReasoned] = useState<{ kind: ReasonKind; scan: Scan }>();
  const documentPath = (scan: Scan) => ({ ...path, documentId: scan.documentId });

  const generate = () =>
    act(async () => {
      const result = ok(
        await api.POST("/api/v1/participations/{participationId}/forms/kug200b", {
          params: { path },
          headers: { "Content-Type": "application/json" },
        }),
      );
      setGenerated(result.checklist);
    }, t("asu.kug200b.messages.generated"));

  return (
    <Section title={t("asu.kug200b.title")}>
      <p data-testid="kug200b-outcome">
        <OutcomeText offer={offer} />
      </p>
      {offer.capabilities.generate && (
        <div>
          <Button size="md" disabled={busy} onClick={() => void generate()}>
            {t("asu.kug200b.generate")}
          </Button>
        </div>
      )}
      {generated && (
        <div role="status" className="tp-fieldset" data-testid="kug200b-checklist">
          <ChecklistText checklist={generated} />
        </div>
      )}
      {offer.forms && (
        <SimpleTable
          title={t("asu.kug200b.forms.title")}
          columns={(["generatedAt", "version", "checklist", "actions"] as const).map((key) => ({
            key,
            header: t(`asu.kug200b.forms.columns.${key}`),
          }))}
          rows={offer.forms.map((form) => ({
            id: form.documentId,
            generatedAt: formatTimestamp(form.generatedAt),
            version: [
              form.formVersion.replace("-", "/"),
              ...(form.versionInUse ? [] : [t("asu.kug200b.forms.outdated")]),
              ...(form.latest ? [] : [t("asu.kug200b.forms.superseded")]),
            ].join(" – "),
            checklist:
              form.checklist.length === 0
                ? t("asu.kug200b.checklist.none")
                : form.checklist.map((item) => item.label).join(", "),
            actions: form.capabilities.open ? (
              <Button
                kind="ghost"
                size="sm"
                aria-label={`${t("asu.kug200b.open")}: ${formatTimestamp(form.generatedAt)}`}
                onClick={() => void props.onOpen(form.documentId)}
              >
                {t("asu.kug200b.open")}
              </Button>
            ) : null,
          }))}
          emptyState={t("asu.kug200b.forms.empty")}
        />
      )}
      {offer.scans && (
        <SimpleTable
          title={t("asu.kug200b.scans.title")}
          columns={(["addedAt", "origin", "version", "signedOn", "state", "actions"] as const).map(
            (key) => ({ key, header: t(`asu.kug200b.scans.columns.${key}`) }),
          )}
          rows={offer.scans.map((scan) => ({
            id: scan.documentId,
            addedAt: formatTimestamp(scan.addedAt),
            origin:
              scan.origin === external
                ? t("asu.kug200b.scans.external")
                : t("asu.kug200b.scans.fromForm"),
            version: scan.formVersion?.replace("-", "/") ?? "—",
            signedOn: scan.signedOn ? formatDate(scan.signedOn) : "—",
            state: scan.quarantine
              ? t("asu.kug200b.scans.quarantined", {
                  reason: t(`asu.proofs.quarantineReasons.${scan.quarantine.reasonCode}`),
                })
              : t(`asu.kug200b.scans.states.${scan.review.state}`),
            actions: (
              <span className="tp-inline-actions">
                {scan.capabilities.open && (
                  <Button kind="ghost" size="sm" onClick={() => void props.onOpen(scan.documentId)}>
                    {t("asu.kug200b.open")}
                  </Button>
                )}
                {scan.capabilities.review && (
                  <>
                    <Button
                      kind="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setReviewing(scan)}
                    >
                      {t("asu.kug200b.review.action")}
                    </Button>
                    <Button
                      kind="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setReasoned({ kind: "reject", scan })}
                    >
                      {t("asu.kug200b.reasons.reject")}
                    </Button>
                  </>
                )}
                {scan.capabilities.delete && (
                  <Button
                    kind="danger--ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setReasoned({ kind: "delete", scan })}
                  >
                    {t("asu.kug200b.reasons.delete")}
                  </Button>
                )}
                {scan.capabilities.quarantine && (
                  <Button
                    kind="danger--ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setReasoned({ kind: "quarantine", scan })}
                  >
                    {t("asu.kug200b.reasons.quarantine")}
                  </Button>
                )}
                {scan.capabilities.liftQuarantine && (
                  <Button
                    kind="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void act(async () =>
                        ok(
                          await api.POST(
                            "/api/v1/participations/{participationId}/documents/{documentId}/quarantine-lift",
                            {
                              params: { path: documentPath(scan) },
                              headers: { "Content-Type": "application/json" },
                            },
                          ),
                        ),
                      )
                    }
                  >
                    {t("asu.proofs.lift")}
                  </Button>
                )}
              </span>
            ),
          }))}
          emptyState={t("asu.kug200b.scans.empty")}
        />
      )}
      {offer.capabilities.addScan && (
        <UploadScan
          offer={offer}
          busy={busy}
          onUpload={(origin, file) =>
            void act(async () => {
              const content = await readFileAsBase64(file);
              ok(
                await api.POST("/api/v1/participations/{participationId}/documents", {
                  params: { path },
                  body: {
                    type: "kug200b_signed_scan",
                    fileName: file.name,
                    content,
                    ...(origin === external
                      ? { origin: external }
                      : { origin: "generated", generationDocumentId: origin }),
                  },
                }),
              );
            }, t("asu.kug200b.messages.uploaded"))
          }
        />
      )}
      {offer.capabilities.decline && (
        <DatedAction
          id="kug200b-declined-on"
          legend={t("asu.kug200b.decline.title")}
          label={t("asu.kug200b.decline.date")}
          action={t("asu.kug200b.decline.save")}
          busy={busy}
          onSave={(declinedOn) =>
            act(async () =>
              ok(
                await api.POST("/api/v1/participations/{participationId}/asu/kug200b-decline", {
                  params: { path },
                  body: { declinedOn },
                }),
              ),
            )
          }
        />
      )}
      <ProfileAccess offer={offer} busy={busy} act={act} path={path} />
      {/* The dialogs only for the readers of the scans (back office has none). */}
      {offer.scans && (
        <>
          <ReviewDialog
            offer={offer}
            scan={reviewing}
            busy={busy}
            onClose={() => setReviewing(undefined)}
            onAccept={(scan, kug200bScan) => {
              setReviewing(undefined);
              void act(
                async () =>
                  ok(
                    await api.POST(
                      "/api/v1/participations/{participationId}/documents/{documentId}/review",
                      {
                        params: { path: documentPath(scan) },
                        body: { decision: "accepted", kug200bScan },
                      },
                    ),
                  ),
                t("asu.kug200b.messages.accepted"),
              );
            }}
          />
          <ReasonDialog
            dialog={reasoned}
            busy={busy}
            onClose={() => setReasoned(undefined)}
            onConfirm={(kind, scan, reason) => {
              setReasoned(undefined);
              const params = { path: documentPath(scan) };
              void act(async () => {
                if (kind === "reject") {
                  return ok(
                    await api.POST(
                      "/api/v1/participations/{participationId}/documents/{documentId}/review",
                      {
                        params,
                        body: { decision: "rejected", reasonCode: reason as "incomplete" },
                      },
                    ),
                  );
                }
                if (kind === "quarantine") {
                  return ok(
                    await api.POST(
                      "/api/v1/participations/{participationId}/documents/{documentId}/quarantine",
                      { params, body: { reasonCode: reason as "suspected_wrong_person" } },
                    ),
                  );
                }
                const { error } = await api.DELETE(
                  "/api/v1/participations/{participationId}/documents/{documentId}",
                  { params: { ...params, query: { reasonCode: reason as "wrong_person" } } },
                );
                if (error) throw error;
              });
            }}
          />
        </>
      )}
    </Section>
  );
}

/** The offer in one line: open, signed or declined (never "missing" once declined). */
function OutcomeText({ offer }: { offer: Offer }) {
  const { t } = useTranslation();
  if (offer.outcome === "signed") return t("asu.kug200b.outcome.signed");
  if (offer.outcome === "declined") {
    return t("asu.kug200b.outcome.declined", { date: formatDate(offer.declinedOn) });
  }
  return offer.offeredOn
    ? t("asu.kug200b.outcome.open", { date: formatDate(offer.offeredOn) })
    : t("asu.kug200b.outcome.none");
}

/** The handwriting and clarification checklist before printing (Q197 (8)). */
function ChecklistText({ checklist }: { checklist: Checklist }) {
  const { t } = useTranslation();
  if (checklist.length === 0) return <p>{t("asu.kug200b.checklist.none")}</p>;
  return (
    <Stack gap={3}>
      <p>{t("asu.kug200b.checklist.intro")}</p>
      <ul className="tp-list">
        {checklist.map((item) => (
          <li key={item.key}>
            {t(`asu.kug200b.checklist.codes.${item.code}`, { label: item.label })}
          </li>
        ))}
      </ul>
      <p className="tp-hint">{t("asu.kug200b.checklist.review")}</p>
    </Stack>
  );
}

/** "Unterschriebenen Kug 200b hochladen": from a generated form, or external paper. */
function UploadScan(props: {
  offer: Offer;
  busy: boolean;
  onUpload: (origin: string, file: File) => void;
}) {
  const { t } = useTranslation();
  const forms = props.offer.forms ?? [];
  // The latest generated form until another origin is chosen (a form generated meanwhile too).
  const [chosen, setChosen] = useState<string>();
  const origin =
    chosen !== undefined && (chosen === external || forms.some((f) => f.documentId === chosen))
      ? chosen
      : (forms[0]?.documentId ?? external);
  return (
    <fieldset className="tp-fieldset">
      <legend>{t("asu.kug200b.scans.upload")}</legend>
      <Stack gap={5}>
        <Select
          id="kug200b-scan-origin"
          labelText={t("asu.kug200b.scans.origin")}
          value={origin}
          onChange={(event) => setChosen(event.target.value)}
        >
          {forms.map((form) => (
            <SelectItem
              key={form.documentId}
              value={form.documentId}
              text={t("asu.kug200b.scans.fromFormAt", { at: formatTimestamp(form.generatedAt) })}
            />
          ))}
          <SelectItem value={external} text={t("asu.kug200b.scans.external")} />
        </Select>
        <div>
          <FileUploaderButton
            id="kug200b-scan-file"
            labelText={t("asu.kug200b.scans.file")}
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

type Review = components["schemas"]["Kug200bScanReview"];

/**
 * "Prüfen" (Q185): the date written in field 19, the three confirmations on the actual paper and,
 * for external paper, the version printed on it. Nothing is preselected.
 */
function ReviewDialog(props: {
  offer: Offer;
  scan: Scan | undefined;
  busy: boolean;
  onClose: () => void;
  onAccept: (scan: Scan, review: Review) => void;
}) {
  const { t } = useTranslation();
  const { scan } = props;
  const versions = props.offer.versions ?? [];
  const isExternal = scan?.origin === external;
  const [date, setDate] = useState("");
  const [confirmed, setConfirmed] = useState<Confirmation[]>([]);
  const [version, setVersion] = useState(versions[0] ?? "");
  const parsed = parseDisplayDate(date);
  const complete =
    parsed.ok &&
    parsed.value !== undefined &&
    confirmed.length === confirmations.length &&
    (!isExternal || version !== "");
  const close = () => {
    setDate("");
    setConfirmed([]);
    props.onClose();
  };
  return (
    <Modal
      open={scan !== undefined}
      modalHeading={t("asu.kug200b.review.title")}
      primaryButtonText={t("asu.kug200b.review.accept")}
      secondaryButtonText={t("asu.kug200b.cancel")}
      primaryButtonDisabled={!complete || props.busy}
      onRequestClose={close}
      onRequestSubmit={() => {
        if (!scan || !complete) return;
        props.onAccept(scan, {
          signedOn: parsed.value!,
          confirmations: confirmed,
          ...(isExternal && { formVersion: version }),
        });
        setDate("");
        setConfirmed([]);
      }}
    >
      <Stack gap={5}>
        <p>{t("asu.kug200b.review.intro")}</p>
        <DateField
          id="kug200b-review-signed-on"
          labelText={t("asu.kug200b.review.signedOn")}
          onChange={setDate}
          invalidText={date !== "" && !parsed.ok ? t("asu.knowledge.invalid") : undefined}
        />
        {confirmations.map((code) => (
          <Checkbox
            key={code}
            id={`kug200b-review-${code}`}
            labelText={t(`asu.kug200b.review.confirmations.${code}`)}
            checked={confirmed.includes(code)}
            onChange={(_, { checked }) =>
              setConfirmed(checked ? [...confirmed, code] : confirmed.filter((c) => c !== code))
            }
          />
        ))}
        {isExternal && (
          <Select
            id="kug200b-review-version"
            labelText={t("asu.kug200b.review.version")}
            value={version}
            onChange={(event) => setVersion(event.target.value)}
          >
            {versions.map((each) => (
              <SelectItem key={each} value={each} text={each.replace("-", "/")} />
            ))}
          </Select>
        )}
      </Stack>
    </Modal>
  );
}

/** "Ablehnen", "Unter Quarantäne stellen" and "Löschen", each with its closed reason. */
function ReasonDialog(props: {
  dialog: { kind: ReasonKind; scan: Scan } | undefined;
  busy: boolean;
  onClose: () => void;
  onConfirm: (kind: ReasonKind, scan: Scan, reason: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const kind = props.dialog?.kind;
  const close = () => {
    setReason("");
    props.onClose();
  };
  return (
    <Modal
      open={kind !== undefined}
      danger={kind === "delete"}
      size="sm"
      modalHeading={kind ? t(`asu.kug200b.reasons.${kind}`) : ""}
      primaryButtonText={kind ? t(`asu.kug200b.reasons.${kind}`) : ""}
      secondaryButtonText={t("asu.kug200b.cancel")}
      primaryButtonDisabled={reason === "" || props.busy}
      onRequestClose={close}
      onRequestSubmit={() => {
        if (!props.dialog || reason === "") return;
        props.onConfirm(props.dialog.kind, props.dialog.scan, reason);
        setReason("");
      }}
    >
      {kind && (
        <Select
          id={`kug200b-${kind}-reason`}
          labelText={t("asu.kug200b.reasons.label")}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        >
          <SelectItem value="" text={t("asu.kug200b.reasons.choose")} />
          {reasons[kind].map((option) => (
            <SelectItem
              key={option}
              value={option}
              text={t(`asu.kug200b.reasons.codes.${option}`)}
            />
          ))}
        </Select>
      )}
    </Modal>
  );
}

/**
 * "Erklärung zum Profilzugriff" (Q185): declaration 17 as written, since the date on the paper;
 * "Widerruf erfasst" with the date received, and "BA informiert am" for each withdrawal. The
 * platform never claims the BA's access was disabled.
 */
function ProfileAccess(props: {
  offer: Offer;
  busy: boolean;
  act: (action: () => Promise<unknown>, done?: string) => Promise<boolean>;
  path: { participationId: string };
}) {
  const { t } = useTranslation();
  const api = useApi();
  const { offer, busy, act, path } = props;
  if (offer.profileAccess === null && offer.withdrawals.length === 0) return null;
  return (
    <fieldset className="tp-fieldset">
      <legend>{t("asu.kug200b.profileAccess.title")}</legend>
      <Stack gap={4}>
        <p>
          {offer.profileAccess
            ? t("asu.kug200b.profileAccess.since", {
                date: formatDate(offer.profileAccess.givenOn),
              })
            : t("asu.kug200b.profileAccess.none")}
        </p>
        {offer.profileAccess && offer.capabilities.recordWithdrawal && (
          <DatedAction
            id="kug200b-withdrawal-received-on"
            legend={t("asu.kug200b.profileAccess.withdrawal")}
            label={t("asu.kug200b.profileAccess.receivedOn")}
            action={t("asu.kug200b.profileAccess.saveWithdrawal")}
            busy={busy}
            onSave={(receivedOn) =>
              act(async () =>
                ok(
                  await api.POST("/api/v1/participations/{participationId}/asu/withdrawal", {
                    params: { path },
                    body: { consentId: offer.profileAccess!.consentId, receivedOn },
                  }),
                ),
              )
            }
          />
        )}
        {offer.withdrawals.length > 0 && (
          <ul className="tp-list">
            {offer.withdrawals.map((withdrawal) => (
              <li key={withdrawal.id}>
                <Stack gap={3}>
                  <span>
                    {[
                      t("asu.kug200b.profileAccess.withdrawn", {
                        date: formatDate(withdrawal.receivedOn),
                      }),
                      withdrawal.baNotifiedOn
                        ? t("asu.kug200b.profileAccess.notified", {
                            date: formatDate(withdrawal.baNotifiedOn),
                          })
                        : t("asu.kug200b.profileAccess.notNotified"),
                    ].join(" – ")}
                  </span>
                  {withdrawal.baNotifiedOn === null && offer.capabilities.recordBaNotice && (
                    <DatedAction
                      id={`kug200b-ba-notified-on-${withdrawal.id}`}
                      legend={t("asu.kug200b.profileAccess.baNotice")}
                      label={t("asu.kug200b.profileAccess.notifiedOn")}
                      action={t("asu.kug200b.profileAccess.saveNotice")}
                      busy={busy}
                      onSave={(notifiedOn) =>
                        act(async () =>
                          ok(
                            await api.POST(
                              "/api/v1/participations/{participationId}/asu/withdrawal-ba-notice",
                              {
                                params: { path },
                                body: { withdrawalId: withdrawal.id, notifiedOn },
                              },
                            ),
                          ),
                        )
                      }
                    />
                  )}
                </Stack>
              </li>
            ))}
          </ul>
        )}
        <p className="tp-hint">{t("asu.kug200b.profileAccess.hint")}</p>
      </Stack>
    </fieldset>
  );
}

/** A date and one button (TT.MM.JJJJ). */
function DatedAction(props: {
  id: string;
  legend: string;
  label: string;
  action: string;
  busy: boolean;
  onSave: (date: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [date, setDate] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [round, setRound] = useState(0);
  const save = async () => {
    const parsed = parseDisplayDate(date);
    if (!parsed.ok || parsed.value === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (await props.onSave(parsed.value)) {
      setDate("");
      setRound(round + 1);
    }
  };
  return (
    <fieldset className="tp-fieldset">
      <legend>{props.legend}</legend>
      <Stack gap={4}>
        <DateField
          key={round}
          id={props.id}
          labelText={props.label}
          onChange={setDate}
          invalidText={invalid ? t("asu.knowledge.invalid") : undefined}
        />
        <div>
          <Button size="md" kind="tertiary" disabled={props.busy} onClick={() => void save()}>
            {props.action}
          </Button>
        </div>
      </Stack>
    </fieldset>
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
