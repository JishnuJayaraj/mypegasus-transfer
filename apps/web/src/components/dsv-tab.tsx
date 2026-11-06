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
  Stack,
  StatusTag,
  Tag,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { participationDsvQuery, useApi } from "../api";
import { documentNavigation } from "./documents-tab";

// The tab "DSV" (process-and-lifecycle.md, the DSV: generation; data-protection.md, generated
// forms; Slice 7 D1–D3): the track and the pinned template, "Vertrag erzeugen" with the deadline
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

export function DsvTab({ participationId }: { participationId: string }) {
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
            actions: generation.capabilities.open ? (
              <Button
                kind="ghost"
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
            onChange={(value) => setChoice(value as Choice)}
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
