import { DsvContract } from "./dsv-contract";
import { EntryClarification } from "./entry-clarification";
import { TgEntryReconciliation } from "./reconciliation";
import { DsvScans } from "./dsv-scans";
import { DsvCustomerNotice } from "./dsv-customer-notice";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  ActionButton,
  Button,
  Card,
  DateField,
  EmptyState,
  formatDate,
  formatTimestamp,
  InlineNotification,
  Loading,
  parseDisplayDate,
  RadioButton,
  RadioButtonGroup,
  SimpleTable,
  SidePanel,
  Stack,
  StatusTag,
  Tag,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { participationDsvQuery, participationQuery, worklistQuery, useApi } from "../api";
import { usePanelNavigationGuard } from "./panel-guard";
import { documentNavigation } from "./documents-tab";

// The tab "DSV" (process-and-lifecycle.md, the DSV: generation; data-protection.md, generated
// forms): the track and the pinned template, "Vertrag erzeugen" with the deadline
// chosen first (the wave's signing deadline for a first offer, else a date entered; nothing
// preset) and what stays for the hand before printing, then the generated papers with "Öffnen" and
// whether each can still be handed out. Every button by its capability; a blocked one names its
// prerequisite (ui-patterns.md, C1). The API checks each again. The DSV is signed on paper (§623
// BGB): nothing here signs. German only.

type View = components["schemas"]["DsvView"];
type Blocker = View["blockers"][number];
type Checklist = View["checklist"];
type Message = { kind: "success" | "error"; text: string };
type Choice = "wave" | "explicit";

/** A write's answer, or its refusal thrown. */
const ok = <T,>(result: { data?: T; error?: unknown }) => {
  if (result.data === undefined) throw result.error ?? new Error("No answer");
  return result.data;
};

const codeOf = (error: unknown) =>
  error instanceof ApiProblemError ? error.problem.errors?.[0]?.code : undefined;

export function DsvTab({
  participationId,
  projectId,
}: {
  participationId: string;
  projectId: string;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const dsvQuery = participationDsvQuery(api, participationId);
  const query = useQuery(dsvQuery);
  const [message, setMessage] = useState<Message>();
  const [busy, setBusy] = useState(false);
  const path = { participationId };

  if (query.isPending) return <Loading label={t("dsv.loading")} />;
  if (query.isError) {
    return (
      <EmptyState variant="error" title={t("dsv.failed")} onRetry={() => void query.refetch()} />
    );
  }
  const view = query.data;

  /** A refusal as the tab's message: its code's text where there is one. */
  function failure(error: unknown): string {
    if (error instanceof ApiProblemError && error.status === 409) return t("dsv.messages.conflict");
    if (error instanceof ApiProblemError && error.status === 403)
      return t("dsv.messages.forbidden");
    const code = codeOf(error);
    const known = code && t(`dsv.codes.${code}` as never, { defaultValue: "" });
    return known || t("dsv.messages.failed");
  }

  async function generate(
    deadline: { kind: "wave"; shown: string } | { kind: "explicit"; date: string },
  ) {
    setBusy(true);
    setMessage(undefined);
    try {
      const result = ok(
        await api.POST("/api/v1/participations/{participationId}/dsv/generations", {
          params: { path },
          body: { deadline, expectedSourceToken: view.sourceToken! },
        }),
      );
      setMessage({
        kind: "success",
        text: t("dsv.messages.generated", { deadline: formatDate(result.offerDeadline) }),
      });
      return true;
    } catch (error) {
      setMessage({ kind: "error", text: failure(error) });
      return false;
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: dsvQuery.queryKey });
    }
  }

  async function refreshStatus() {
    const detailQuery = participationQuery(api, participationId);
    const detail = queryClient.getQueryData(detailQuery.queryKey);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: detailQuery.queryKey }),
      ...(detail
        ? [
            queryClient.invalidateQueries({
              queryKey: worklistQuery(api, detail.projectId).queryKey,
            }),
          ]
        : []),
    ]);
  }

  async function offer(
    generationId?: string,
    external?: { deadline: string; printedTgStart: string; printedTgEnd: string },
    statusVersion = view.statusVersion,
  ) {
    setBusy(true);
    try {
      ok(
        await api.POST("/api/v1/participations/{participationId}/dsv/offers", {
          params: { path },
          body: generationId
            ? { generationId, statusVersion }
            : { external: external!, statusVersion },
        }),
      );
      setMessage({ kind: "success", text: t("dsv.offers.recorded") });
      return true;
    } catch (error) {
      setMessage({ kind: "error", text: failure(error) });
      return false;
    } finally {
      setBusy(false);
      await refreshStatus();
    }
  }
  async function decline(offerId: string, statusVersion: number) {
    setBusy(true);
    try {
      ok(
        await api.POST("/api/v1/participations/{participationId}/dsv/offers/{offerId}/decline", {
          params: { path: { ...path, offerId } },
          body: { statusVersion },
        }),
      );
      setMessage({ kind: "success", text: t("dsv.offers.declined") });
    } catch (error) {
      setMessage({ kind: "error", text: failure(error) });
    } finally {
      setBusy(false);
      await refreshStatus();
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
      <Card title={t("dsv.state.title")} level={3}>
        <Stack gap={4}>
          <div className="tp-inline-actions">
            <StatusTag family="dsv" code={view.track} prefix={t("dsv.state.track")} />
          </div>
          <p>
            {view.template
              ? t(view.template.approvedForLive ? "dsv.state.template" : "dsv.state.sample", {
                  version: view.template.version,
                })
              : t("dsv.state.noTemplate")}
          </p>
          <p>
            {view.facts.dsvGenerated
              ? t("dsv.state.generated", {
                  date: formatDate(view.facts.dsvGenerated.validOn),
                })
              : t("dsv.state.notGenerated")}
          </p>
          <p className="tp-hint">{t("dsv.state.paper")}</p>
        </Stack>
      </Card>
      {view.track !== "dsv_signed" && (
        <GenerateCard view={view} busy={busy} onGenerate={generate} />
      )}
      <Card title={t("dsv.offers.title")} level={3}>
        <Stack gap={4}>
          {view.offers.map((item) => (
            <div key={item.id}>
              <p>
                {t(`dsv.offers.${item.origin}`)} {" · "} {formatDate(item.offerDeadline)} {" · "}
                {item.endedAs ? t(`dsv.offers.${item.endedAs}`) : t("dsv.offers.open")}
              </p>
              {item.capabilities.decline && (
                <Button
                  disabled={busy}
                  kind="tertiary"
                  onClick={() => void decline(item.id, view.statusVersion)}
                >
                  {t("dsv.offers.decline")}
                </Button>
              )}
            </div>
          ))}
          <ExternalOffer
            busy={busy}
            available={view.capabilities.offer}
            statusVersion={view.statusVersion}
            onOffer={(external, version) => offer(undefined, external, version)}
          />
        </Stack>
      </Card>
      {/* A signed DSV that has not entered after its planned start: shown only then. */}
      {view.track === "dsv_signed" && <EntryClarification participationId={participationId} />}
      {view.track === "dsv_signed" && <TgEntryReconciliation participationId={participationId} />}
      <DsvCustomerNotice view={view} />
      <DsvScans view={view} projectId={projectId} onOpen={open} />
      <DsvContract view={view} />
      {/* The cancellation of the signed contract (process-and-lifecycle.md, the cancellation). */}
      {(view.track === "dsv_signed" || view.cancellations.length > 0) && (
        <DsvScans view={view} projectId={projectId} onOpen={open} paper="cancellation" />
      )}
      <Card title={t("dsv.generations.title")} level={3}>
        <SimpleTable
          title={t("dsv.generations.title")}
          hideTitle
          columns={(
            ["generatedAt", "template", "deadline", "checklist", "state", "actions"] as const
          ).map((key) => ({ key, header: t(`dsv.generations.columns.${key}`) }))}
          rows={view.generations.map((generation) => ({
            id: generation.documentId,
            generatedAt: formatTimestamp(generation.generatedAt),
            template: generation.templateVersion,
            deadline: `${formatDate(generation.offerDeadline)} (${t(`dsv.deadlineKinds.${generation.deadlineKind}`)})`,
            checklist: <ChecklistText checklist={generation.checklist} short />,
            state: generation.stale ? (
              <Tag type="gray" size="sm">
                {t("dsv.generations.stale")}
              </Tag>
            ) : (
              <Tag type="green" size="sm">
                {t("dsv.generations.current")}
              </Tag>
            ),
            actions: (
              <div className="tp-inline-actions">
                {view.capabilities.offer && !generation.stale && (
                  <Button
                    disabled={busy}
                    kind="tertiary"
                    size="sm"
                    onClick={() => void offer(generation.generationId)}
                  >
                    {t("dsv.offers.offer")}
                  </Button>
                )}
                {generation.capabilities.open ? (
                  <Button
                    kind="tertiary"
                    size="sm"
                    aria-label={t("dsv.generations.openAt", {
                      at: formatTimestamp(generation.generatedAt),
                    })}
                    onClick={() => void open(generation.documentId)}
                  >
                    {t("dsv.generations.open")}
                  </Button>
                ) : (
                  "—"
                )}
              </div>
            ),
          }))}
          emptyState={t("dsv.generations.empty")}
        />
      </Card>
    </Stack>
  );
}

/**
 * "Vertrag erzeugen": the deadline first (C1's prerequisite where generation is blocked), nothing
 * preset; the handwriting checklist before printing.
 */
function GenerateCard(props: {
  view: View;
  busy: boolean;
  onGenerate: (
    deadline: { kind: "wave"; shown: string } | { kind: "explicit"; date: string },
  ) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const { view, busy } = props;
  const [choice, setChoice] = useState<Choice>();
  const [typed, setTyped] = useState("");
  const [shownInvalid, setShownInvalid] = useState(false);
  const waveDeadline = view.deadline.waveSigningDeadline;
  const waveOffered = !view.deadline.explicitRequired && waveDeadline !== null;
  const parsed = parseDisplayDate(typed);
  const date = parsed.ok ? (parsed.value ?? null) : null;
  const blocker: Blocker | undefined = view.blockers[0];
  const reason = blocker
    ? t(`dsv.codes.${blocker}`)
    : choice === undefined
      ? t("dsv.generate.chooseDeadline")
      : choice === "explicit" && date === null
        ? t("dsv.generate.enterDate")
        : null;

  async function submit() {
    if (choice === "explicit" && date === null) {
      setShownInvalid(true);
      return;
    }
    const done = await props.onGenerate(
      choice === "wave"
        ? { kind: "wave", shown: waveDeadline! }
        : { kind: "explicit", date: date! },
    );
    if (done) {
      setChoice(undefined);
      setTyped("");
      setShownInvalid(false);
    }
  }

  return (
    <Card
      title={t("dsv.generate.title")}
      level={3}
      description={
        view.deadline.latestEntryDate && view.deadline.tgStart
          ? t("dsv.generate.bounds", {
              latest: formatDate(
                view.deadline.latestEntryDate < view.deadline.tgStart
                  ? view.deadline.latestEntryDate
                  : view.deadline.tgStart,
              ),
            })
          : undefined
      }
    >
      <Stack gap={5}>
        {blocker === undefined ? (
          <RadioButtonGroup
            legendText={t("dsv.generate.deadline")}
            name="dsv-deadline"
            orientation="vertical"
            valueSelected={choice ?? ""}
            onChange={(value) => {
              // The date field starts blank on every choice: a date typed before can't linger
              // unseen and be submitted.
              setChoice(value as Choice);
              setTyped("");
              setShownInvalid(false);
            }}
          >
            {[
              ...(waveOffered
                ? [
                    <RadioButton
                      key="wave"
                      id="dsv-deadline-wave"
                      value="wave"
                      labelText={t("dsv.generate.wave", { date: formatDate(waveDeadline) })}
                    />,
                  ]
                : []),
              <RadioButton
                key="explicit"
                id="dsv-deadline-explicit"
                value="explicit"
                labelText={t("dsv.generate.explicit")}
              />,
            ]}
          </RadioButtonGroup>
        ) : null}
        {view.deadline.explicitRequired && blocker === undefined && (
          <p className="tp-hint">{t("dsv.generate.reoffer")}</p>
        )}
        {view.facts.dsvGenerated && blocker === undefined && (
          <p className="tp-hint">
            {t("dsv.generate.again", { date: formatDate(view.facts.dsvGenerated.validOn) })}
          </p>
        )}
        {choice === "explicit" && (
          <DateField
            id="dsv-deadline-date"
            labelText={t("dsv.generate.date")}
            onChange={(value) => {
              setTyped(value);
              setShownInvalid(false);
            }}
            invalidText={shownInvalid ? t("dsv.generate.dateInvalid") : undefined}
          />
        )}
        {blocker === undefined && (
          <div className="tp-fieldset" aria-live="polite" data-testid="dsv-checklist">
            <ChecklistText checklist={view.checklist} />
          </div>
        )}
        <div>
          <ActionButton
            size="md"
            disabled={busy}
            unavailableReason={reason}
            onClick={() => void submit()}
          >
            {t("dsv.generate.action")}
          </ActionButton>
        </div>
      </Stack>
    </Card>
  );
}

/** What stays for the hand before printing (Q197): each value by its label, never the value. */
function ChecklistText({ checklist, short }: { checklist: Checklist; short?: boolean }) {
  const { t } = useTranslation();
  if (checklist.length === 0) {
    return short ? <>{t("dsv.checklist.noneShort")}</> : <p>{t("dsv.checklist.none")}</p>;
  }
  const labels = checklist.map((item) => t(`dsv.checklist.keys.${item.key}`));
  if (short) return <>{labels.join(", ")}</>;
  return (
    <Stack gap={3}>
      <p>{t("dsv.checklist.intro")}</p>
      <ul className="tp-list">
        {labels.map((label) => (
          <li key={label}>{t("dsv.checklist.item", { label })}</li>
        ))}
      </ul>
    </Stack>
  );
}

type ExternalPaper = { deadline: string; printedTgStart: string; printedTgEnd: string };
function ExternalOffer({
  busy,
  available,
  statusVersion,
  onOffer,
}: {
  busy: boolean;
  available: boolean;
  statusVersion: number;
  onOffer: (external: ExternalPaper, version: number) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [version, setVersion] = useState<number | null>(null);
  const [values, setValues] = useState({ deadline: "", printedTgStart: "", printedTgEnd: "" });
  const [failed, setFailed] = useState(false);
  const dirty = Object.values(values).some(Boolean);
  const pendingNavigation = usePanelNavigationGuard(version !== null && dirty);
  const parsed = Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      const result = parseDisplayDate(value);
      return [key, result.ok ? result.value : null];
    }),
  );
  const close = () => {
    setVersion(null);
    setValues({ deadline: "", printedTgStart: "", printedTgEnd: "" });
    setFailed(false);
  };
  async function submit() {
    if (await onOffer(parsed as ExternalPaper, version!)) close();
    else setFailed(true);
  }
  return (
    <>
      {available && (
        <Button disabled={busy} kind="tertiary" onClick={() => setVersion(statusVersion)}>
          {t("dsv.offers.externalAction")}
        </Button>
      )}
      <SidePanel
        open={version !== null}
        title={t("dsv.offers.externalAction")}
        dirty={dirty}
        onClose={close}
        pendingNavigation={pendingNavigation}
      >
        {version !== null && (
          <Stack gap={4}>
            <p>{t("dsv.offers.externalHint")}</p>
            {failed && (
              <InlineNotification kind="error" title={t("dsv.offers.externalFailed")} lowContrast />
            )}
            {(["deadline", "printedTgStart", "printedTgEnd"] as const).map((key) => (
              <DateField
                key={key}
                id={`dsv-external-${key}`}
                labelText={t(`dsv.offers.${key}`)}
                onChange={(value) => setValues((before) => ({ ...before, [key]: value }))}
              />
            ))}
            <ActionButton
              disabled={busy}
              unavailableReason={
                Object.values(parsed).some((value) => !value) ? t("dsv.offers.completeDates") : null
              }
              onClick={() => void submit()}
            >
              {t("dsv.offers.offer")}
            </ActionButton>
          </Stack>
        )}
      </SidePanel>
    </>
  );
}
