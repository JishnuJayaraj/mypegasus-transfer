import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import { otherAssessmentLines, type AssessmentLine } from "@transfer/domain";
import {
  Button,
  Form,
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
  TextArea,
  TextInput,
  useToast,
} from "@transfer/ui";
import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { participationProfilingQuery, participationQuery, useApi } from "../api";
import { SelfServiceTab } from "./self-service-tab";

// The tab "Profiling" (process-and-lifecycle.md and data-protection.md, the profiling record):
// the track and its steps, the sessions, section B as the tab "Selbstauskunft" shows it with
// "Im assistierten Modus ergänzen"; for the assigned consultant the unemployment period, section C
// with p. 7 and the pending declarations to the BA. Every button follows the API's capabilities.
// Section C and the unemployment period are loaded on "Anzeigen" from their logged routes and kept
// only in this component's state, never in the query cache.

type Detail = components["schemas"]["ParticipationDetail"];
type View = components["schemas"]["Profiling"];
type Assessment = components["schemas"]["ProfilingAssessment"];
type Rating = "no_need" | "placement_relevant";

/** The problem's codes, by the body location they point at. */
function codesAt(error: unknown): { status: number | null; codes: [string, string][] } {
  if (!(error instanceof ApiProblemError)) return { status: null, codes: [] };
  return {
    status: error.status,
    codes: (error.problem.errors ?? []).map((item) => [item.pointer ?? "", item.code]),
  };
}

export function ProfilingTab({ detail, projectId }: { detail: Detail; projectId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const query = useQuery(participationProfilingQuery(api, detail.id));
  const [stale, setStale] = useState<"sessions" | "declarations">();
  if (query.isPending) return <p aria-live="polite">{t("profiling.loading")}</p>;
  if (query.isError) {
    const forbidden = query.error instanceof ApiProblemError && query.error.status === 403;
    return <p role="alert">{t(forbidden ? "profiling.forbidden" : "profiling.failed")}</p>;
  }
  const view = query.data;
  // A section remounts with each revision; a "changed meanwhile" notice outlives that.
  const notice = (section: "sessions" | "declarations") => ({
    stale: stale === section,
    onStale: (now: boolean) => setStale(now ? section : undefined),
  });
  return (
    <Stack gap={7}>
      <StatusSection view={view} />
      {/* Remounted with each revision: the editor starts from what was saved. */}
      <SessionsSection key={`sessions-${view.revision}`} view={view} {...notice("sessions")} />
      <section className="tp-section" aria-labelledby="profiling-self-service">
        <h2 id="profiling-self-service">{t("profiling.selfService.title")}</h2>
        <p>{t("profiling.selfService.intro")}</p>
        <SelfServiceTab
          detail={detail}
          projectId={projectId}
          startLabel={t("participant.selfService.startAssisted")}
        />
      </section>
      {view.capabilities.record && <UnemploymentSection view={view} />}
      {view.capabilities.assessment && view.assessment && <AssessmentSection view={view} />}
      {view.capabilities.record && view.declarations && (
        <DeclarationsSection
          key={`declarations-${view.revision}`}
          view={view}
          {...notice("declarations")}
        />
      )}
    </Stack>
  );
}

/** Keeps a write's answer as the tab's state and refreshes the participation's statuses. */
function useSaved(participationId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return {
    saved: (view: View) =>
      queryClient.setQueryData(participationProfilingQuery(api, participationId).queryKey, view),
    reload: () =>
      queryClient.invalidateQueries({
        queryKey: participationProfilingQuery(api, participationId).queryKey,
      }),
    statusChanged: () =>
      queryClient.invalidateQueries({
        queryKey: participationQuery(api, participationId).queryKey,
      }),
  };
}

function StatusSection({ view }: { view: View }) {
  const { t } = useTranslation();
  const api = useApi();
  const { saved, reload, statusChanged } = useSaved(view.participationId);
  const [declining, setDeclining] = useState(false);
  const [failure, setFailure] = useState<"failed" | "stale">();
  const step = useMutation({
    mutationFn: async (to: View["transitions"][number]["to"]) => {
      const { data } = await api.POST("/api/v1/participations/{participationId}/profiling-status", {
        params: { path: { participationId: view.participationId } },
        body: { to, statusVersion: view.statusVersion },
      });
      if (!data) throw new Error("No profiling");
      return data;
    },
    onSuccess: async (updated) => {
      setFailure(undefined);
      setDeclining(false);
      saved(updated);
      await statusChanged();
    },
    onError: async (error) => {
      setFailure(codesAt(error).status === 409 ? "stale" : "failed");
      setDeclining(false);
      await reload();
    },
  });
  // `profiling_done` comes with the signed TL 407 (its own section).
  const steps = view.transitions.filter((s) => s.to !== "profiling_done");
  const allowed = steps.filter((s) => s.allowed);
  const refusal = steps.find((s) => !s.allowed)?.refusal;
  const label = (to: string) =>
    to === "profiling_accepted" && view.profilingStatus === "profiling_declined"
      ? t("profiling.status.actions.profiling_accepted_again")
      : t(`profiling.status.actions.${to as "profiling_accepted"}`);
  return (
    <section className="tp-section" aria-labelledby="profiling-status">
      <h2 id="profiling-status">{t("profiling.status.title")}</h2>
      <dl className="tp-facts">
        <div>
          <dt>{t("profiling.status.current")}</dt>
          <dd>{t(`participants.profilingStatuses.${view.profilingStatus}`)}</dd>
        </div>
        {view.profilingDoneOn && (
          <div>
            <dt>{t("profiling.status.doneOn")}</dt>
            <dd>{formatDate(view.profilingDoneOn)}</dd>
          </div>
        )}
      </dl>
      {failure && (
        <InlineNotification
          kind="error"
          title={t(`profiling.status.${failure}`)}
          hideCloseButton
          lowContrast
        />
      )}
      {allowed.length === 0 && refusal === "track_inactive" && (
        <p>{t("profiling.status.inactive")}</p>
      )}
      {allowed.length === 0 && refusal === "project_not_active" && (
        <p>{t("profiling.status.projectNotActive")}</p>
      )}
      <div className="tp-inline-actions">
        {allowed.map(({ to }) => (
          <Button
            key={to}
            kind={to === "profiling_declined" ? "danger--tertiary" : "secondary"}
            disabled={step.isPending}
            onClick={() => (to === "profiling_declined" ? setDeclining(true) : step.mutate(to))}
          >
            {label(to)}
          </Button>
        ))}
      </div>
      <Modal
        open={declining}
        danger
        modalHeading={t("profiling.status.declineHeading")}
        primaryButtonText={t("profiling.status.declineConfirm")}
        secondaryButtonText={t("profiling.status.cancel")}
        primaryButtonDisabled={step.isPending}
        onRequestSubmit={() => step.mutate("profiling_declined")}
        onRequestClose={() => setDeclining(false)}
        size="sm"
      >
        <p>{t("profiling.status.declineText")}</p>
      </Modal>
    </section>
  );
}

type SessionRow = { key: number; id?: string; date: string; from: string; to: string };
let lastRow = 0;
const time = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

type Notice = { stale: boolean; onStale: (stale: boolean) => void };

function SessionsSection({ view, stale, onStale }: { view: View } & Notice) {
  const { t } = useTranslation();
  const api = useApi();
  const showToast = useToast();
  const { saved, reload } = useSaved(view.participationId);
  const [rows, setRows] = useState<SessionRow[]>(() =>
    view.sessions.map((s) => ({
      key: ++lastRow,
      id: s.id,
      date: formatDate(s.date),
      from: s.from,
      to: s.to,
    })),
  );
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [failed, setFailed] = useState(false);
  const failure = failed ? "failed" : stale ? "stale" : undefined;
  const save = useMutation({
    mutationFn: async (sessions: components["schemas"]["ProfilingSessionInput"][]) => {
      const { data } = await api.PUT(
        "/api/v1/participations/{participationId}/profiling/sessions",
        {
          params: { path: { participationId: view.participationId } },
          body: { revision: view.revision, sessions },
        },
      );
      if (!data) throw new Error("No profiling");
      return data;
    },
    onSuccess: (updated) => {
      onStale(false);
      showToast({ title: t("profiling.sessions.saved") });
      saved(updated);
    },
    onError: async (error) => {
      const { status, codes } = codesAt(error);
      if (status === 409) {
        onStale(true);
        await reload();
        return;
      }
      if (status !== 422) {
        setFailed(true);
        return;
      }
      const next: Record<string, string[]> = {};
      for (const [pointer, code] of codes) {
        // `/sessions/<index>/<field>` or `/sessions/<index>`: the row's key.
        const index = Number(pointer.split("/")[2]);
        const key = Number.isInteger(index) ? `${rows[index]?.key}` : "form";
        (next[key] ??= []).push(code);
      }
      setErrors(next);
    },
  });

  if (!view.capabilities.record) {
    return (
      <section className="tp-section" aria-labelledby="profiling-sessions">
        <h2 id="profiling-sessions">{t("profiling.sessions.title")}</h2>
        <SimpleTable
          title={t("profiling.sessions.title")}
          columns={(["date", "from", "to"] as const).map((key) => ({
            key,
            header: t(`profiling.sessions.${key}`),
          }))}
          rows={view.sessions.map((s) => ({
            id: s.id,
            date: formatDate(s.date),
            from: s.from,
            to: s.to,
          }))}
          emptyState={t("profiling.sessions.empty")}
        />
      </section>
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setFailed(false);
    onStale(false);
    const next: Record<string, string[]> = {};
    const sessions = rows.map((row) => {
      const date = parseDisplayDate(row.date);
      const problems = [
        ...(date.ok && date.value ? [] : ["dateInvalid"]),
        ...(time.test(row.from) && time.test(row.to) ? [] : ["timeInvalid"]),
      ];
      if (problems.length > 0) next[`${row.key}`] = problems;
      return {
        ...(row.id && { id: row.id }),
        date: date.ok ? (date.value ?? "") : "",
        from: row.from,
        to: row.to,
      };
    });
    setErrors(next);
    if (Object.keys(next).length === 0) save.mutate(sessions);
  }

  const update = (key: number, change: Partial<SessionRow>) =>
    setRows(rows.map((row) => (row.key === key ? { ...row, ...change } : row)));
  const message = (code: string) =>
    code === "dateInvalid" || code === "timeInvalid"
      ? t(`profiling.sessions.${code}`)
      : t(`profiling.sessions.errors.${code as "sessions_overlap"}`, {
          defaultValue: t("profiling.sessions.failed"),
        });

  return (
    <section className="tp-section" aria-labelledby="profiling-sessions">
      <h2 id="profiling-sessions">{t("profiling.sessions.title")}</h2>
      <p>{t("profiling.sessions.intro")}</p>
      <Form className="tp-form" onSubmit={submit} noValidate>
        <Stack gap={5}>
          {failure && (
            <InlineNotification
              kind="error"
              title={t(`profiling.sessions.${failure}`)}
              hideCloseButton
              lowContrast
            />
          )}
          {rows.length === 0 && <p>{t("profiling.sessions.empty")}</p>}
          {rows.map((row, index) => (
            <fieldset key={row.key} className="tp-fieldset">
              <legend>{t("profiling.sessions.row", { number: index + 1 })}</legend>
              <div className="tp-inline-actions">
                <TextInput
                  id={`session-${row.key}-date`}
                  labelText={t("profiling.sessions.date")}
                  placeholder="TT.MM.JJJJ"
                  value={row.date}
                  onChange={(event) => update(row.key, { date: event.target.value })}
                />
                <TextInput
                  id={`session-${row.key}-from`}
                  labelText={t("profiling.sessions.from")}
                  placeholder="hh:mm"
                  value={row.from}
                  onChange={(event) => update(row.key, { from: event.target.value })}
                />
                <TextInput
                  id={`session-${row.key}-to`}
                  labelText={t("profiling.sessions.to")}
                  placeholder="hh:mm"
                  value={row.to}
                  onChange={(event) => update(row.key, { to: event.target.value })}
                />
                <Button
                  kind="ghost"
                  size="sm"
                  aria-label={t("profiling.sessions.removeLabel", { number: index + 1 })}
                  onClick={() => setRows(rows.filter((other) => other.key !== row.key))}
                >
                  {t("profiling.sessions.remove")}
                </Button>
              </div>
              {(errors[`${row.key}`] ?? []).map((code) => (
                <p key={code} className="tp-error">
                  {message(code)}
                </p>
              ))}
            </fieldset>
          ))}
          {(errors.form ?? []).map((code) => (
            <p key={code} className="tp-error">
              {message(code)}
            </p>
          ))}
          <div className="tp-inline-actions">
            <Button
              kind="tertiary"
              onClick={() => setRows([...rows, { key: ++lastRow, date: "", from: "", to: "" }])}
            >
              {t("profiling.sessions.add")}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {t("profiling.sessions.save")}
            </Button>
          </div>
        </Stack>
      </Form>
    </section>
  );
}

/** "angegeben / fehlt" and "Anzeigen" / "Ausblenden" for a block read on its logged route. */
function SensitiveHeader(props: {
  present: boolean;
  shown: boolean;
  busy: boolean;
  failed: boolean;
  onShow: () => void;
  onHide: () => void;
  label: string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <p className="tp-hint">{t("profiling.sensitive.loggedHint")}</p>
      <p className="tp-inline-actions">
        {!props.shown &&
          t(props.present ? "profiling.sensitive.given" : "profiling.sensitive.absent")}
        <Button
          kind="ghost"
          size="sm"
          disabled={props.busy}
          aria-label={`${props.label}: ${t(props.shown ? "profiling.sensitive.hide" : "profiling.sensitive.show")}`}
          onClick={props.shown ? props.onHide : props.onShow}
        >
          {t(props.shown ? "profiling.sensitive.hide" : "profiling.sensitive.show")}
        </Button>
        {props.failed && <span className="tp-error">{t("profiling.sensitive.showFailed")}</span>}
      </p>
    </>
  );
}

function UnemploymentSection({ view }: { view: View }) {
  const { t } = useTranslation();
  const api = useApi();
  const showToast = useToast();
  const { saved } = useSaved(view.participationId);
  const [form, setForm] = useState<{ from: string; until: string }>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string>();
  const title = t("profiling.unemployment.title");

  async function show() {
    setBusy(true);
    setFailed(false);
    try {
      const { data } = await api.GET(
        "/api/v1/participations/{participationId}/profiling/unemployment",
        { params: { path: { participationId: view.participationId } } },
      );
      if (!data) throw new Error("No period");
      setForm({ from: formatDate(data.period?.from), until: formatDate(data.period?.until) });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  async function write(period: components["schemas"]["UnemploymentPeriod"] | null) {
    setBusy(true);
    setError(undefined);
    try {
      const { data } = await api.PUT(
        "/api/v1/participations/{participationId}/profiling/unemployment",
        { params: { path: { participationId: view.participationId } }, body: { period } },
      );
      if (!data) throw new Error("No profiling");
      saved(data);
      showToast({ title: t("profiling.unemployment.saved") });
      if (period === null) setForm({ from: "", until: "" });
    } catch {
      setError(t("profiling.unemployment.failed"));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    const from = parseDisplayDate(form.from);
    const until = parseDisplayDate(form.until);
    if (!from.ok || !from.value) return setError(t("profiling.unemployment.fromRequired"));
    if (!until.ok) return setError(t("profiling.sessions.dateInvalid"));
    void write({ from: from.value, until: until.value ?? null });
  }

  return (
    <section className="tp-section" aria-labelledby="profiling-unemployment">
      <h2 id="profiling-unemployment">{title}</h2>
      <SensitiveHeader
        present={view.unemploymentPeriodRecorded === true}
        shown={form !== undefined}
        busy={busy}
        failed={failed}
        label={title}
        onShow={() => void show()}
        onHide={() => setForm(undefined)}
      />
      {form && (
        <Form className="tp-form" onSubmit={submit} noValidate>
          <Stack gap={5}>
            {error && <InlineNotification kind="error" title={error} hideCloseButton lowContrast />}
            <TextInput
              id="unemployment-from"
              labelText={t("profiling.unemployment.from")}
              placeholder="TT.MM.JJJJ"
              value={form.from}
              onChange={(event) => setForm({ ...form, from: event.target.value })}
            />
            <TextInput
              id="unemployment-until"
              labelText={t("profiling.unemployment.until")}
              helperText={t("profiling.unemployment.untilHint")}
              placeholder="TT.MM.JJJJ"
              value={form.until}
              onChange={(event) => setForm({ ...form, until: event.target.value })}
            />
            <div className="tp-inline-actions">
              <Button type="submit" disabled={busy}>
                {t("profiling.unemployment.save")}
              </Button>
              <Button kind="ghost" disabled={busy} onClick={() => void write(null)}>
                {t("profiling.unemployment.clear")}
              </Button>
            </div>
          </Stack>
        </Form>
      )}
    </section>
  );
}

const groups: [string, readonly (AssessmentLine | "health")[]][] = [
  [
    "qualification",
    [
      "schoolQualification",
      "vocationalQualification",
      "workExperience",
      "languageSkills",
      "otherQualification",
    ],
  ],
  ["performance", ["health", "intellectualCapacity", "workAndSocialBehaviour", "otherPerformance"]],
  ["motivation", ["initiative", "learningReadiness", "otherMotivation"]],
  ["conditions", ["localMobility", "otherConditions"]],
];

type LineForm = { rating: Rating | null; text: string; label: string };
type AssessmentForm = Record<AssessmentLine | "health", LineForm> & {
  overallAssessment: string;
  nextSteps: string;
};

function toForm(values: Assessment): AssessmentForm {
  const lines = Object.fromEntries(
    groups
      .flatMap(([, keys]) => keys)
      .map((key) => {
        const line = values[key] as {
          rating: Rating | null;
          text?: string | null;
          label?: string | null;
        };
        return [key, { rating: line.rating, text: line.text ?? "", label: line.label ?? "" }];
      }),
  ) as Record<AssessmentLine | "health", LineForm>;
  return {
    ...lines,
    overallAssessment: values.overallAssessment ?? "",
    nextSteps: values.nextSteps ?? "",
  };
}

const orNull = (value: string) => (value.trim() === "" ? null : value.trim());

function toValues(form: AssessmentForm): Assessment {
  const lines = Object.fromEntries(
    groups
      .flatMap(([, keys]) => keys)
      .map((key) => {
        const line = form[key];
        if (key === "health") return [key, { rating: line.rating }];
        const value = { rating: line.rating, text: orNull(line.text) };
        return [
          key,
          otherAssessmentLines.has(key) ? { ...value, label: orNull(line.label) } : value,
        ];
      }),
  );
  return {
    ...lines,
    overallAssessment: orNull(form.overallAssessment),
    nextSteps: orNull(form.nextSteps),
  } as Assessment;
}

function AssessmentSection({ view }: { view: View }) {
  const { t } = useTranslation();
  const api = useApi();
  const showToast = useToast();
  const { saved } = useSaved(view.participationId);
  const [loaded, setLoaded] = useState<{ revision: number; form: AssessmentForm }>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const title = t("profiling.assessment.title");

  async function show() {
    setBusy(true);
    setFailed(false);
    try {
      const { data } = await api.GET(
        "/api/v1/participations/{participationId}/profiling/assessment",
        { params: { path: { participationId: view.participationId } } },
      );
      if (!data) throw new Error("No assessment");
      setLoaded({ revision: data.revision, form: toForm(data.values) });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!loaded) return;
    setBusy(true);
    setFailure(undefined);
    setErrors({});
    try {
      const { data } = await api.PUT(
        "/api/v1/participations/{participationId}/profiling/assessment",
        {
          params: { path: { participationId: view.participationId } },
          body: { revision: loaded.revision, values: toValues(loaded.form) },
        },
      );
      if (!data) throw new Error("No profiling");
      saved(data);
      setLoaded({ ...loaded, revision: data.assessment?.revision ?? loaded.revision });
      showToast({ title: t("profiling.assessment.saved") });
    } catch (error) {
      const { status, codes } = codesAt(error);
      if (status === 409) {
        setLoaded(undefined);
        setFailure(t("profiling.assessment.stale"));
      } else if (status === 422) {
        setErrors(
          Object.fromEntries(
            codes.map(([pointer, code]) => [
              pointer,
              t(`profiling.assessment.errors.${code as "too_long"}`, {
                defaultValue: t("profiling.assessment.failed"),
              }),
            ]),
          ),
        );
      } else {
        setFailure(t("profiling.assessment.failed"));
      }
    } finally {
      setBusy(false);
    }
  }

  const set = (key: AssessmentLine | "health", change: Partial<LineForm>) =>
    loaded &&
    setLoaded({ ...loaded, form: { ...loaded.form, [key]: { ...loaded.form[key], ...change } } });
  const invalid = (pointer: string) =>
    errors[pointer] ? { invalid: true, invalidText: errors[pointer] } : {};
  const recorded = view.assessment?.recorded.length ?? 0;

  return (
    <section className="tp-section" aria-labelledby="profiling-assessment">
      <h2 id="profiling-assessment">{title}</h2>
      <p>{t("profiling.assessment.intro")}</p>
      <p>{t("profiling.assessment.recorded", { count: recorded })}</p>
      {failure && <InlineNotification kind="error" title={failure} hideCloseButton lowContrast />}
      <SensitiveHeader
        present={recorded > 0}
        shown={loaded !== undefined}
        busy={busy}
        failed={failed}
        label={title}
        onShow={() => void show()}
        onHide={() => setLoaded(undefined)}
      />
      {loaded && (
        <Form className="tp-form" onSubmit={(event) => void submit(event)} noValidate>
          <Stack gap={6}>
            <p className="tp-hint">{t("profiling.assessment.pageHint")}</p>
            {groups.map(([group, keys]) => (
              <fieldset key={group} className="tp-fieldset">
                <legend>{t(`profiling.assessment.groups.${group as "qualification"}`)}</legend>
                <Stack gap={5}>
                  {keys.map((key) => (
                    <LineEditor
                      key={key}
                      lineKey={key}
                      line={loaded.form[key]}
                      onChange={(change) => set(key, change)}
                      invalid={invalid}
                    />
                  ))}
                </Stack>
              </fieldset>
            ))}
            <TextArea
              id="assessment-overall"
              labelText={t("profiling.assessment.overallAssessment")}
              maxCount={2000}
              enableCounter
              value={loaded.form.overallAssessment}
              onChange={(event) =>
                setLoaded({
                  ...loaded,
                  form: { ...loaded.form, overallAssessment: event.target.value },
                })
              }
              {...invalid("/values/overallAssessment")}
            />
            <TextArea
              id="assessment-next-steps"
              labelText={t("profiling.assessment.nextSteps")}
              maxCount={2000}
              enableCounter
              value={loaded.form.nextSteps}
              onChange={(event) =>
                setLoaded({ ...loaded, form: { ...loaded.form, nextSteps: event.target.value } })
              }
              {...invalid("/values/nextSteps")}
            />
            <div>
              <Button type="submit" disabled={busy}>
                {t("profiling.assessment.save")}
              </Button>
            </div>
          </Stack>
        </Form>
      )}
    </section>
  );
}

function LineEditor(props: {
  lineKey: AssessmentLine | "health";
  line: LineForm;
  onChange: (change: Partial<LineForm>) => void;
  invalid: (pointer: string) => { invalid?: boolean; invalidText?: ReactNode };
}) {
  const { t } = useTranslation();
  const { lineKey: key, line, onChange, invalid } = props;
  const name = t(`profiling.assessment.lines.${key}`);
  const other = key !== "health" && otherAssessmentLines.has(key);
  return (
    <div className="tp-assessment-line">
      <RadioButtonGroup
        name={`assessment-${key}`}
        legendText={name}
        orientation="horizontal"
        valueSelected={line.rating ?? "none"}
        onChange={(value) => onChange({ rating: value === "none" ? null : (value as Rating) })}
      >
        {(["no_need", "placement_relevant", "none"] as const).map((value) => (
          <RadioButton
            key={value}
            id={`assessment-${key}-${value}`}
            value={value}
            labelText={t(`profiling.assessment.rating.${value}`)}
          />
        ))}
      </RadioButtonGroup>
      {key === "health" ? (
        <p className="tp-hint">{t("profiling.assessment.healthNote")}</p>
      ) : (
        <>
          {other && (
            <TextInput
              id={`assessment-${key}-label`}
              labelText={`${name}: ${t("profiling.assessment.label")}`}
              maxLength={100}
              value={line.label}
              onChange={(event) => onChange({ label: event.target.value })}
              {...invalid(`/values/${key}/label`)}
            />
          )}
          <TextInput
            id={`assessment-${key}-text`}
            labelText={`${name}: ${t("profiling.assessment.text")}`}
            maxLength={300}
            value={line.text}
            onChange={(event) => onChange({ text: event.target.value })}
            {...invalid(`/values/${key}/text`)}
          />
        </>
      )}
    </div>
  );
}

type Choice = NonNullable<View["declarations"]>["jobboerseChoice"];

function DeclarationsSection({ view, stale, onStale }: { view: View } & Notice) {
  const { t } = useTranslation();
  const api = useApi();
  const showToast = useToast();
  const { saved, reload } = useSaved(view.participationId);
  const declarations = view.declarations!;
  const [choice, setChoice] = useState<Choice>(declarations.jobboerseChoice);
  const [contact, setContact] = useState<boolean | null>(declarations.baContactConsent);
  const [failed, setFailed] = useState(false);
  const failure = failed ? "failed" : stale ? "stale" : undefined;
  const save = useMutation({
    mutationFn: async () => {
      const { data } = await api.PUT(
        "/api/v1/participations/{participationId}/profiling/declarations",
        {
          params: { path: { participationId: view.participationId } },
          body: { revision: view.revision, jobboerseChoice: choice, baContactConsent: contact },
        },
      );
      if (!data) throw new Error("No profiling");
      return data;
    },
    onSuccess: (updated) => {
      onStale(false);
      showToast({ title: t("profiling.declarations.saved") });
      saved(updated);
    },
    onError: async (error) => {
      if (codesAt(error).status !== 409) return setFailed(true);
      onStale(true);
      await reload();
    },
  });
  const choices = ["full", "anonymous_callme", "anonymous_no_contact", "none"] as const;
  return (
    <section className="tp-section" aria-labelledby="profiling-declarations">
      <h2 id="profiling-declarations">{t("profiling.declarations.title")}</h2>
      <p>{t("profiling.declarations.intro")}</p>
      <Form
        className="tp-form"
        onSubmit={(event) => {
          event.preventDefault();
          setFailed(false);
          onStale(false);
          save.mutate();
        }}
        noValidate
      >
        <Stack gap={5}>
          {failure && (
            <InlineNotification
              kind="error"
              title={t(`profiling.declarations.${failure}`)}
              hideCloseButton
              lowContrast
            />
          )}
          <Select
            id="declarations-jobboerse"
            labelText={t("profiling.declarations.jobboerse")}
            value={choice ?? "open"}
            onChange={(event) =>
              setChoice(event.target.value === "open" ? null : (event.target.value as Choice))
            }
          >
            <SelectItem value="open" text={t("profiling.declarations.jobboerseOptions.open")} />
            {choices.map((value) => (
              <SelectItem
                key={value}
                value={value}
                text={t(`profiling.declarations.jobboerseOptions.${value}`)}
              />
            ))}
          </Select>
          <RadioButtonGroup
            name="declarations-ba-contact"
            legendText={t("profiling.declarations.baContact")}
            orientation="horizontal"
            valueSelected={contact === null ? "open" : contact ? "yes" : "no"}
            onChange={(value) => setContact(value === "open" ? null : value === "yes")}
          >
            {(["yes", "no", "open"] as const).map((value) => (
              <RadioButton
                key={value}
                id={`declarations-ba-contact-${value}`}
                value={value}
                labelText={t(`profiling.declarations.baContactOptions.${value}`)}
              />
            ))}
          </RadioButtonGroup>
          {declarations.recordedAt && (
            <p className="tp-hint">
              {t("profiling.declarations.recordedAt", {
                at: formatTimestamp(declarations.recordedAt),
              })}
            </p>
          )}
          <div>
            <Button type="submit" disabled={save.isPending}>
              {t("profiling.declarations.save")}
            </Button>
          </div>
        </Stack>
      </Form>
    </section>
  );
}
