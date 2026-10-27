import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  Button,
  Checkbox,
  formatTimestamp,
  InlineNotification,
  SimpleTable,
  Stack,
  useToast,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { participationProfilingQuery, useApi } from "../api";
import { documentNavigation } from "./documents-tab";
import { SignedScans } from "./tl407-scans";

// The section "Profilingbogen (TL 407)" of the tab "Profiling" (data-protection.md, generated
// forms and the readiness projection; ba-forms.md): the readiness as the API projects it for the
// viewer (the profiler's on "Prüfen", each decryption logged; the PL's summary at once),
// "Erzeugen" with each warning confirmed, the generated forms with "Öffnen" (a logged opening)
// and "Neu erzeugen", and the signed paper (tl407-scans.tsx). Every button follows the API's
// capabilities; German only.

type View = components["schemas"]["Profiling"];
type Readiness = components["schemas"]["Tl407Readiness"];
type ProfilerReadiness = components["schemas"]["Tl407ProfilerReadiness"];
type Summary = components["schemas"]["Tl407ReadinessSummary"];
type WarningCode = components["schemas"]["Tl407WarningCode"];

type Failure = "failed" | "stale" | "pdfUnavailable" | "storageUnavailable" | "refused";

/** A refused generation or opening as the section's message. */
function failureOf(error: unknown): Failure {
  if (!(error instanceof ApiProblemError)) return "failed";
  const codes = (error.problem.errors ?? []).map((item) => item.code);
  if (error.status === 409) return "stale";
  if (codes.includes("pdf_unavailable")) return "pdfUnavailable";
  if (codes.includes("storage_unavailable")) return "storageUnavailable";
  return error.status === 422 ? "refused" : "failed";
}

const readinessPath = "/api/v1/participations/{participationId}/forms/tl407/readiness";

export function Tl407Section({ view }: { view: View }) {
  const { t } = useTranslation();
  const { readTl407Readiness, readAssessment } = view.capabilities;
  // The profiler, who reads section C, gets the full check; the PL the summary.
  return (
    <section className="tp-section" aria-labelledby="profiling-tl407">
      <h2 id="profiling-tl407">{t("profiling.tl407.title")}</h2>
      <p>{t("profiling.tl407.intro")}</p>
      <Stack gap={6}>
        {readTl407Readiness && readAssessment && <ProfilerReadinessBlock view={view} />}
        {readTl407Readiness && !readAssessment && (
          <SummaryBlock participationId={view.participationId} />
        )}
        <GeneratedForms view={view} />
        <SignedScans key={view.tl407SignedOn ?? "unsigned"} view={view} />
      </Stack>
    </section>
  );
}

/** The PL's summary: presence only, loaded at once (no logged read behind it). */
function SummaryBlock({ participationId }: { participationId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const query = useQuery({
    queryKey: ["participations", participationId, "tl407-readiness"],
    queryFn: async () => {
      const { data } = await api.GET(readinessPath, { params: { path: { participationId } } });
      if (!data) throw new Error("No readiness");
      return data as Summary;
    },
  });
  if (query.isPending) return <p aria-live="polite">{t("profiling.tl407.loading")}</p>;
  if (query.isError) return <p role="alert">{t("profiling.tl407.readinessFailed")}</p>;
  const summary = query.data;
  return (
    <div>
      <h3>{t("profiling.tl407.readiness")}</h3>
      {summary.ready ? (
        <p>{t("profiling.tl407.summaryReady")}</p>
      ) : summary.missing.length > 0 ? (
        <>
          <p>{t("profiling.tl407.summaryMissing")}</p>
          <ul className="tp-list">
            {summary.missing.map((item) => (
              <li key={item.key}>{item.label}</li>
            ))}
          </ul>
        </>
      ) : (
        <p>{t("profiling.tl407.summaryNotReady")}</p>
      )}
      <p className="tp-hint">{t("profiling.tl407.summaryHint")}</p>
    </div>
  );
}

/** The profiler's check on "Prüfen", the confirmations and "Erzeugen". */
function ProfilerReadinessBlock({ view }: { view: View }) {
  const { t } = useTranslation();
  const api = useApi();
  const showToast = useToast();
  const queryClient = useQueryClient();
  const participationId = view.participationId;
  const [readiness, setReadiness] = useState<ProfilerReadiness>();
  const [confirmed, setConfirmed] = useState<WarningCode[]>([]);
  const [failure, setFailure] = useState<Failure>();
  const check = useMutation({
    mutationFn: async () => {
      const { data } = await api.GET(readinessPath, { params: { path: { participationId } } });
      if (!data) throw new Error("No readiness");
      return data as Readiness;
    },
    onSuccess: (data) => {
      setConfirmed([]);
      if (data.view === "profiler") setReadiness(data);
    },
    onError: () => setFailure("failed"),
  });
  const generate = useMutation({
    // The confirmations hold for the sources this readiness showed (its token), nothing else.
    mutationFn: async (checked: ProfilerReadiness) => {
      const { data } = await api.POST("/api/v1/participations/{participationId}/forms/tl407", {
        params: { path: { participationId } },
        body: { sourceToken: checked.sourceToken, confirmWarnings: confirmed },
      });
      if (!data) throw new Error("No generation");
      return data;
    },
    onSuccess: async (generated) => {
      showToast({
        title: t(
          generated.anlage ? "profiling.tl407.generatedWithAnlage" : "profiling.tl407.generated",
        ),
      });
      setReadiness(undefined);
      setConfirmed([]);
      await queryClient.invalidateQueries({
        queryKey: participationProfilingQuery(api, participationId).queryKey,
      });
    },
    onError: async (error) => {
      const next = failureOf(error);
      setFailure(next);
      // The sources moved, or the check refused: the readiness is checked again.
      if (next === "stale" || next === "refused") check.mutate();
    },
  });
  const warningCodes = [...new Set((readiness?.warnings ?? []).map((warning) => warning.code))];
  const allConfirmed = warningCodes.every((code) => confirmed.includes(code));
  const regenerate = view.tl407Forms.length > 0;
  return (
    <div>
      <h3>{t("profiling.tl407.readiness")}</h3>
      <p className="tp-hint">{t("profiling.tl407.loggedHint")}</p>
      <Stack gap={5}>
        {failure && (
          <InlineNotification
            kind="error"
            title={t(`profiling.tl407.failures.${failure}`)}
            hideCloseButton
            lowContrast
          />
        )}
        <div>
          <Button
            kind="tertiary"
            size="sm"
            disabled={check.isPending}
            onClick={() => {
              setFailure(undefined);
              check.mutate();
            }}
          >
            {t(readiness ? "profiling.tl407.checkAgain" : "profiling.tl407.check")}
          </Button>
        </div>
        {readiness && (
          <ReadinessResult
            readiness={readiness}
            confirmed={confirmed}
            onConfirm={(code, on) =>
              setConfirmed(on ? [...confirmed, code] : confirmed.filter((each) => each !== code))
            }
          />
        )}
        {readiness?.ready && view.capabilities.generateTl407 && (
          <div>
            <Button
              disabled={!allConfirmed || generate.isPending}
              onClick={() => {
                setFailure(undefined);
                generate.mutate(readiness);
              }}
            >
              {t(regenerate ? "profiling.tl407.regenerate" : "profiling.tl407.generate")}
            </Button>
          </div>
        )}
      </Stack>
    </div>
  );
}

function ReadinessResult(props: {
  readiness: ProfilerReadiness;
  confirmed: readonly WarningCode[];
  onConfirm: (code: WarningCode, on: boolean) => void;
}) {
  const { t } = useTranslation();
  const { readiness, confirmed } = props;
  const row = (issue: { row?: number }) =>
    issue.row === undefined ? "" : ` (${t("profiling.tl407.row", { row: issue.row + 1 })})`;
  const warnings = [...new Map(readiness.warnings.map((each) => [each.code, each])).values()];
  return (
    <Stack gap={4}>
      {readiness.formVersion === null ? (
        <p aria-live="polite">{t("profiling.tl407.noVersion")}</p>
      ) : (
        <p aria-live="polite">
          {t(readiness.ready ? "profiling.tl407.ready" : "profiling.tl407.notReady", {
            version: readiness.formVersion.replace("-", "/"),
          })}
        </p>
      )}
      {readiness.errors.length > 0 && (
        <div>
          <h4>{t("profiling.tl407.errorsTitle")}</h4>
          <ul className="tp-list">
            {readiness.errors.map((issue) => (
              <li key={`${issue.code}-${issue.key}-${issue.row ?? ""}`}>
                <strong>{`${issue.label}${row(issue)}:`}</strong>{" "}
                {t(`profiling.tl407.errors.${issue.code}`)}
              </li>
            ))}
          </ul>
          {readiness.errors.some((issue) => issue.code === "character_unsupported") && (
            <p className="tp-hint">{t("profiling.tl407.externalPaper")}</p>
          )}
        </div>
      )}
      {warnings.length > 0 && (
        <fieldset className="tp-fieldset">
          <legend>{t("profiling.tl407.warningsTitle")}</legend>
          {warnings.map((warning) => (
            <Checkbox
              key={warning.code}
              id={`tl407-confirm-${warning.code}`}
              labelText={`${warning.label}: ${t(`profiling.tl407.warnings.${warning.code}`)}`}
              checked={confirmed.includes(warning.code)}
              onChange={(_, { checked }) => props.onConfirm(warning.code, checked)}
            />
          ))}
        </fieldset>
      )}
      {readiness.overflow.length > 0 && (
        <div>
          <p>{t("profiling.tl407.overflow")}</p>
          <ul className="tp-list">
            {readiness.overflow.map((entry) => (
              <li key={entry.key}>{entry.label}</li>
            ))}
          </ul>
        </div>
      )}
    </Stack>
  );
}

/** The generated forms: metadata, "Öffnen" by its capability; an expired version says so. */
function GeneratedForms({ view }: { view: View }) {
  const { t } = useTranslation();
  const api = useApi();
  const [failed, setFailed] = useState(false);
  async function open(documentId: string) {
    setFailed(false);
    try {
      const { data } = await api.POST(
        "/api/v1/participations/{participationId}/documents/{documentId}/opening",
        {
          params: { path: { participationId: view.participationId, documentId } },
          headers: { "Content-Type": "application/json" },
        },
      );
      if (!data) throw new Error("No opening");
      documentNavigation.assign(data.url);
    } catch {
      setFailed(true);
    }
  }
  const latest = view.tl407Forms.find((form) => form.latest);
  return (
    <Stack gap={4}>
      {failed && (
        <InlineNotification
          kind="error"
          title={t("profiling.tl407.openFailed")}
          hideCloseButton
          lowContrast
        />
      )}
      {latest && !latest.versionInUse && (
        <p aria-live="polite">{t("profiling.tl407.versionExpired")}</p>
      )}
      <SimpleTable
        title={t("profiling.tl407.formsTitle")}
        columns={(["generatedAt", "version", "anlage", "state", "actions"] as const).map((key) => ({
          key,
          header: t(`profiling.tl407.columns.${key}`),
        }))}
        rows={view.tl407Forms.map((form) => ({
          id: form.documentId,
          generatedAt: formatTimestamp(form.generatedAt),
          version: form.formVersion.replace("-", "/"),
          anlage: t(form.anlage ? "profiling.tl407.anlageYes" : "profiling.tl407.anlageNo"),
          state: t(form.latest ? "profiling.tl407.latest" : "profiling.tl407.superseded"),
          actions: form.capabilities.open ? (
            <Button
              kind="ghost"
              size="sm"
              aria-label={`${t("profiling.tl407.open")}: ${formatTimestamp(form.generatedAt)}`}
              onClick={() => void open(form.documentId)}
            >
              {t("profiling.tl407.open")}
            </Button>
          ) : (
            ""
          ),
        }))}
        emptyState={t("profiling.tl407.formsEmpty")}
      />
    </Stack>
  );
}
