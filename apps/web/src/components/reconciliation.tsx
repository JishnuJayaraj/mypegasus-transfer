import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  ReconciliationReplyCode,
  correctionSourceMaxLength,
  normaliseCorrectionSource,
} from "@transfer/domain";
import {
  ActionButton,
  Card,
  Checkbox,
  formatDate,
  formatTimestamp,
  InlineNotification,
  Loading,
  Select,
  SelectItem,
  SidePanel,
  Stack,
  TextInput,
} from "@transfer/ui";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { tgEntryReconciliationQuery, useApi } from "../api";
import { usePanelNavigationGuard } from "./panel-guard";

// The reconciliation of a missed TG entry (process-and-lifecycle.md, the reconciliation; Q68 case
// 2, Q80, Q216): "Eintritt nachträglich erfassen" lists the evidence with its actual days and asks
// the PL's confirmation, nothing preset; the target and the version are captured when the dialog
// opens. On the tab "DSV" the recorded reconciliation, its review's steps and the PL's reply to the
// manager's clarification. Every button by its capability; the API checks each again. German only.

type State = components["schemas"]["TgEntryReconciliationState"];
type Step = NonNullable<State["reconciliation"]>["steps"][number];

/** One review step as a line: the day, the kind, the code and the documented source. */
export function reconciliationStepText(
  t: TFunction,
  step: Pick<Step, "kind" | "code" | "source" | "on">,
): string {
  const code = step.code
    ? t(
        `reconciliation.${step.kind === "replied" ? "replyCodes" : "reasonCodes"}.${step.code}` as never,
      )
    : null;
  const text = [t(`reconciliation.steps.kinds.${step.kind}`), code, step.source]
    .filter(Boolean)
    .join(" – ");
  return t("reconciliation.steps.step", { date: formatDate(step.on), text });
}

/** The refusal's message key: a stale read, a permission, a domain rule, or a failure. */
function errorKey(error: unknown): string {
  if (!(error instanceof ApiProblemError)) return "failed";
  if (error.status === 409) return "stale";
  if (error.status === 403) return "forbidden";
  if (error.status === 422) return "domain";
  return "failed";
}

/**
 * "Eintritt nachträglich erfassen": the dialog keeps the evidence and the status version it opened
 * with, lists each with the day it is valid from and the day it was recorded, and sends them with
 * the PL's confirmation. A refusal names what moved; the dialog never retries with new values.
 */
export function ReconciliationDialog({
  participationId,
  onClose,
}: {
  participationId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const cache = useQueryClient();
  const query = useQuery(tgEntryReconciliationQuery(api, participationId));
  // The target captured when the dialog opened (ui-patterns.md, C4): the first read.
  const [read, setRead] = useState<State | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigation = usePanelNavigationGuard(confirmed);
  if (read === null && query.data) setRead(query.data);
  const state = read;

  async function save() {
    if (!state) return;
    setBusy(true);
    setError(null);
    try {
      const { error: problem } = await api.POST(
        "/api/v1/participations/{participationId}/tg-entry-reconciliation",
        {
          params: { path: { participationId } },
          body: {
            evidence: state.evidence.map(({ kind, id, validOn }) => ({ kind, id, validOn })),
            statusVersion: state.statusVersion,
            confirmed: true,
          },
        },
      );
      if (problem) throw problem;
      onClose();
    } catch (problem) {
      setError(errorKey(problem));
    } finally {
      setBusy(false);
      await cache.invalidateQueries({ queryKey: ["participations", participationId] });
    }
  }

  const blocked = state?.capabilities.reconcile ? null : state?.refusal;
  return (
    <SidePanel
      open
      title={t("reconciliation.title")}
      dirty={confirmed}
      onClose={onClose}
      pendingNavigation={navigation}
    >
      {!state ? (
        query.isError ? (
          <p role="alert">{t("reconciliation.failed")}</p>
        ) : (
          <Loading label={t("reconciliation.loading")} />
        )
      ) : (
        <Stack gap={4}>
          {blocked && (
            <InlineNotification
              kind="info"
              title={t(`reconciliation.refusals.${blocked}`)}
              hideCloseButton
              lowContrast
            />
          )}
          {error && (
            <InlineNotification
              kind="error"
              role="alert"
              title={t(`reconciliation.errors.${error as "failed"}`)}
              lowContrast
            />
          )}
          {state.tgStart && (
            <p>{t("reconciliation.intro", { date: formatDate(state.tgStart) })}</p>
          )}
          <section aria-labelledby="reconciliation-evidence">
            <h4 id="reconciliation-evidence">{t("reconciliation.evidence.title")}</h4>
            {state.evidence.length === 0 ? (
              <p>{t("reconciliation.evidence.none")}</p>
            ) : (
              <ul className="tp-list" data-testid="reconciliation-evidence">
                {state.evidence.map((e) => (
                  <li key={e.kind}>
                    {t("reconciliation.evidence.item", {
                      kind: t(`reconciliation.evidenceKinds.${e.kind}`),
                      valid: formatDate(e.validOn),
                      recorded: formatTimestamp(e.recordedAt),
                    })}
                  </li>
                ))}
              </ul>
            )}
            {state.problems.length > 0 && (
              <ul className="tp-list">
                {state.problems.map((p) => (
                  <li key={p.fact}>
                    {t(`reconciliation.problems.${p.code as "evidence_missing"}`, {
                      fact: t(`reconciliation.facts.${p.fact}`),
                    })}
                  </li>
                ))}
              </ul>
            )}
          </section>
          {!blocked && (
            <>
              <Checkbox
                id="reconciliation-confirmed"
                labelText={t("reconciliation.confirm")}
                checked={confirmed}
                onChange={(_, data) => setConfirmed(data.checked)}
              />
              <ActionButton
                disabled={busy}
                unavailableReason={confirmed ? null : t("reconciliation.complete")}
                onClick={() => void save()}
              >
                {t("reconciliation.save")}
              </ActionButton>
            </>
          )}
        </Stack>
      )}
    </SidePanel>
  );
}

/**
 * The recorded reconciliation on the tab "DSV": when it was made, its effective date, the stage
 * of the review (the day it is due is informational, never a deadline), every step, and the PL's
 * reply while the manager's clarification awaits one ("Rückfrage zum Eintritt").
 */
export function TgEntryReconciliation({ participationId }: { participationId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const cache = useQueryClient();
  const query = useQuery(tgEntryReconciliationQuery(api, participationId));
  const [code, setCode] = useState("");
  const [source, setSource] = useState("");
  const [shownInvalid, setShownInvalid] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string }>();
  const reply = useMutation({
    mutationFn: async (target: { id: string; revision: number }) => {
      const { error } = await api.POST("/api/v1/reconciliations/{reconciliationId}/reply", {
        params: { path: { reconciliationId: target.id } },
        body: {
          code: code as components["schemas"]["ReconciliationReplyCode"],
          source,
          revision: target.revision,
        },
      });
      if (error) throw error;
    },
    onSuccess: async () => {
      setMessage({ kind: "success", text: t("reconciliation.reply.saved") });
      setCode("");
      setSource("");
      setShownInvalid(false);
      await cache.invalidateQueries({ queryKey: ["participations", participationId] });
    },
    onError: async (error) => {
      setMessage({ kind: "error", text: t(`reconciliation.errors.${errorKey(error) as "failed"}`) });
      await cache.invalidateQueries({ queryKey: ["participations", participationId] });
    },
  });

  if (query.isPending) return <Loading label={t("reconciliation.loading")} />;
  if (query.isError) return <p role="alert">{t("reconciliation.failed")}</p>;
  const { reconciliation, capabilities } = query.data;
  if (!reconciliation) return null;
  const normalised = normaliseCorrectionSource(source);
  const sourceValid = normalised !== null && normalised.length <= correctionSourceMaxLength;
  const request = reconciliation.steps.findLast((s) => s.kind === "clarification_requested");
  return (
    <Card title={t("reconciliation.cardTitle")} level={3} id="tg-entry-reconciliation">
      <Stack gap={5}>
        <p>
          {t("reconciliation.status", {
            reconciled: formatDate(reconciliation.reconciledOn),
            date: formatDate(reconciliation.effectiveDate),
            stage: t(`reconciliation.stages.${reconciliation.stage}`),
            due: formatDate(reconciliation.reviewDueOn),
          })}
        </p>
        {message && (
          <InlineNotification
            kind={message.kind}
            role={message.kind === "error" ? "alert" : "status"}
            title={message.text}
            onClose={() => setMessage(undefined)}
            lowContrast
          />
        )}
        <ul className="tp-list">
          {reconciliation.evidence.map((e) => (
            <li key={e.kind}>
              {t("reconciliation.evidence.days", {
                kind: t(`reconciliation.evidenceKinds.${e.kind}`),
                valid: formatDate(e.validOn),
                recorded: formatDate(e.recordedOn),
              })}
            </li>
          ))}
        </ul>
        {reconciliation.steps.length > 0 && (
          <section aria-labelledby="reconciliation-steps">
            <h4 id="reconciliation-steps">{t("reconciliation.steps.title")}</h4>
            <ol className="tp-list" data-testid="reconciliation-steps">
              {reconciliation.steps.map((step, index) => (
                <li key={index}>{reconciliationStepText(t, step)}</li>
              ))}
            </ol>
          </section>
        )}
        {capabilities.reply && request && (
          <section aria-labelledby="reconciliation-reply">
            <h4 id="reconciliation-reply">{t("reconciliation.reply.title")}</h4>
            <Stack gap={4}>
              <InlineNotification
                kind="warning"
                hideCloseButton
                lowContrast
                title={t("reconciliation.reply.request", {
                  date: formatDate(request.on),
                  code: t(`reconciliation.reasonCodes.${request.code}` as never),
                  source: request.source,
                })}
              />
              <p className="tp-hint">{t("reconciliation.reply.hint")}</p>
              <Select
                id="reconciliation-reply-code"
                labelText={t("reconciliation.reply.code")}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              >
                <SelectItem value="" text="" />
                {ReconciliationReplyCode.options.map((option) => (
                  <SelectItem
                    key={option}
                    value={option}
                    text={t(`reconciliation.replyCodes.${option}`)}
                  />
                ))}
              </Select>
              <TextInput
                id="reconciliation-reply-source"
                labelText={t("reconciliation.reply.source")}
                value={source}
                maxLength={correctionSourceMaxLength}
                invalid={shownInvalid && !sourceValid}
                invalidText={t("reconciliation.reply.sourceInvalid")}
                onChange={(event) => {
                  setSource(event.target.value);
                  setShownInvalid(false);
                }}
              />
              <div>
                <ActionButton
                  size="md"
                  disabled={reply.isPending}
                  unavailableReason={code === "" ? t("reconciliation.reply.choose") : null}
                  onClick={() => {
                    if (!sourceValid) setShownInvalid(true);
                    else reply.mutate({ id: reconciliation.id, revision: reconciliation.revision });
                  }}
                >
                  {t("reconciliation.reply.save")}
                </ActionButton>
              </div>
            </Stack>
          </section>
        )}
      </Stack>
    </Card>
  );
}
