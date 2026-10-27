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
import { Tl407Section } from "./tl407-section";

// The tab "Profiling" (process-and-lifecycle.md and data-protection.md, the profiling record):
// the track and its steps, the sessions, section B as the tab "Selbstauskunft" shows it with
// "Im assistierten Modus ergänzen"; for the assigned consultant the unemployment period, section C
// with p. 7 and the pending declarations to the BA; the TL 407 (tl407-section.tsx). Every button
// follows the API's capabilities.
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
  if (query.isPending) return <p aria-live="polite">{t("profiling.loading")}</p>;
  if (query.isError) {
    const forbidden = query.error instanceof ApiProblemError && query.error.status === 403;
    return <p role="alert">{t(forbidden ? "profiling.forbidden" : "profiling.failed")}</p>;
  }
  const view = query.data;
  return (
    <Stack gap={7}>
      {view.closed && (
        <InlineNotification kind="info" title={t("profiling.closed")} hideCloseButton lowContrast />
      )}
      <StatusSection view={view} />
      <SessionsSection view={view} />
      <section className="tp-section" aria-labelledby="profiling-self-service">
        <h2 id="profiling-self-service">{t("profiling.selfService.title")}</h2>
        <p>{t("profiling.selfService.intro")}</p>
        <SelfServiceTab
          detail={detail}
          projectId={projectId}
          startLabel={t("participant.selfService.startAssisted")}
        />
      </section>
      {view.unemploymentPeriodRecorded !== undefined &&
        view.capabilities.readUnemploymentPeriod && <UnemploymentSection view={view} />}
      {view.capabilities.readAssessment && view.assessment && <AssessmentSection view={view} />}
      {view.declarations && <DeclarationsSection view={view} />}
      {(view.capabilities.readTl407Readiness ||
        view.tl407Forms.length > 0 ||
        view.tl407Scans.length > 0) && <Tl407Section view={view} />}
    </Stack>
  );
}

/**
 * A section's draft over the server's value and the revision it was read with (ADR-0010; no
 * silent loss). Clean, it follows every new server state. Dirty, it keeps the input; its token
 * moves on only while the server's value of this section is still the one the draft started from
 * (another section's save shares the revision); a draft equal to the new value is clean again; any
 * other changed value is a conflict, shown, which only
 * "Neu laden" resolves by taking the server's state. A save sends `token`, so a conflict's save is
 * refused (409), never silently applied.
 */
function useDraft<T>(server: { revision: number; value: T }, same: (a: T, b: T) => boolean) {
  const [base, setBase] = useState(server);
  const [draft, setDraft] = useState(server.value);
  const dirty = !same(draft, base.value);
  if (server.revision !== base.revision) {
    if (!dirty || same(draft, server.value)) {
      setBase(server);
      setDraft(server.value);
    } else if (same(server.value, base.value)) {
      setBase({ revision: server.revision, value: base.value });
    }
  }
  const conflict = dirty && server.revision !== base.revision && !same(server.value, base.value);
  /** Takes this server state as the draft's (after a save, or "Neu laden"). */
  const adopt = (next: { revision: number; value: T }) => {
    setBase(next);
    setDraft(next.value);
  };
  return { draft, setDraft, dirty, conflict, token: base.revision, adopt };
}

/**
 * A warning that the stored value changed elsewhere, with "Neu laden" beside it (Carbon's inline
 * notification takes no interactive children).
 */
function ReloadNotice({ title, onReload }: { title: string; onReload: () => void }) {
  const { t } = useTranslation();
  return (
    <div>
      <InlineNotification kind="warning" title={title} hideCloseButton lowContrast />
      <Button kind="ghost" size="sm" onClick={onReload}>
        {t("profiling.draft.reload")}
      </Button>
    </div>
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
  // `profiling_done` comes with the signed TL 407 (its own section, tl407-scans.tsx).
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
      {allowed.length === 0 && refusal === "track_inactive" && !view.closed && (
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

const sessionRows = (sessions: View["sessions"]): SessionRow[] =>
  sessions.map((s) => ({
    key: ++lastRow,
    id: s.id,
    date: formatDate(s.date),
    from: s.from,
    to: s.to,
  }));
/** Two lists of rows the same as the server would store them (row keys aside). */
const sameRows = (a: readonly SessionRow[], b: readonly SessionRow[]) =>
  a.length === b.length &&
  a.every(
    (row, i) =>
      row.id === b[i]!.id &&
      row.date === b[i]!.date &&
      row.from === b[i]!.from &&
      row.to === b[i]!.to,
  );

function SessionsSection({ view }: { view: View }) {
  const { t } = useTranslation();
  const api = useApi();
  const showToast = useToast();
  const { saved, reload } = useSaved(view.participationId);
  const {
    draft: rows,
    setDraft: setRows,
    conflict,
    token,
    adopt,
  } = useDraft({ revision: view.revision, value: sessionRows(view.sessions) }, sameRows);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [failure, setFailure] = useState<"failed" | "stale">();
  const save = useMutation({
    mutationFn: async (sessions: components["schemas"]["ProfilingSessionInput"][]) => {
      const { data } = await api.PUT(
        "/api/v1/participations/{participationId}/profiling/sessions",
        {
          params: { path: { participationId: view.participationId } },
          body: { revision: token, sessions },
        },
      );
      if (!data) throw new Error("No profiling");
      return data;
    },
    onSuccess: ({ profiling }) => {
      showToast({ title: t("profiling.sessions.saved") });
      // The record as read after the save: its sessions with their own revision.
      adopt({ revision: profiling.revision, value: sessionRows(profiling.sessions) });
      saved(profiling);
    },
    onError: async (error) => {
      const { status, codes } = codesAt(error);
      if (status === 409) {
        // The draft stays; the record is read again and a changed value shows as a conflict.
        setFailure("stale");
        await reload();
        return;
      }
      if (status !== 422) {
        setFailure("failed");
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
    setFailure(undefined);
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
          {conflict && (
            <ReloadNotice
              title={t("profiling.draft.conflict")}
              onReload={() => {
                setFailure(undefined);
                adopt({ revision: view.revision, value: sessionRows(view.sessions) });
              }}
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

type PeriodForm = { revision: number; from: string; until: string };

function UnemploymentSection({ view }: { view: View }) {
  const { t } = useTranslation();
  const api = useApi();
  const showToast = useToast();
  const { saved } = useSaved(view.participationId);
  // The period as read with its revision; the inputs edit it, a save sends that revision.
  const [form, setForm] = useState<PeriodForm>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string>();
  const [stale, setStale] = useState(false);
  const [reversed, setReversed] = useState(false);
  const title = t("profiling.unemployment.title");
  const writable = view.capabilities.record;

  async function show() {
    setBusy(true);
    setFailed(false);
    setStale(false);
    try {
      const { data } = await api.GET(
        "/api/v1/participations/{participationId}/profiling/unemployment",
        { params: { path: { participationId: view.participationId } } },
      );
      if (!data) throw new Error("No period");
      setForm({
        revision: data.revision,
        from: formatDate(data.period?.from),
        until: formatDate(data.period?.until),
      });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  async function write(
    current: PeriodForm,
    period: components["schemas"]["UnemploymentPeriod"] | null,
  ) {
    setBusy(true);
    setError(undefined);
    setReversed(false);
    try {
      const { data } = await api.PUT(
        "/api/v1/participations/{participationId}/profiling/unemployment",
        {
          params: { path: { participationId: view.participationId } },
          body: { revision: current.revision, period },
        },
      );
      if (!data) throw new Error("No profiling");
      saved(data.profiling);
      // This save's own revision goes with the values it stored.
      setForm(
        period === null
          ? { revision: data.revision, from: "", until: "" }
          : { ...current, revision: data.revision },
      );
      setReversed(data.warnings.includes("range_reversed"));
      showToast({ title: t("profiling.unemployment.saved") });
    } catch (failure) {
      if (codesAt(failure).status === 409) setStale(true);
      else setError(t("profiling.unemployment.failed"));
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
    void write(form, { from: from.value, until: until.value ?? null });
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
        onHide={() => {
          setForm(undefined);
          setStale(false);
          setReversed(false);
        }}
      />
      {stale && (
        <ReloadNotice title={t("profiling.unemployment.stale")} onReload={() => void show()} />
      )}
      {reversed && (
        <InlineNotification
          kind="warning"
          title={t("profiling.unemployment.reversed")}
          hideCloseButton
          lowContrast
        />
      )}
      {form && !writable && (
        <dl className="tp-facts">
          <div>
            <dt>{t("profiling.unemployment.from")}</dt>
            <dd>{form.from || "—"}</dd>
          </div>
          <div>
            <dt>{t("profiling.unemployment.until")}</dt>
            <dd>{form.until || "—"}</dd>
          </div>
        </dl>
      )}
      {form && writable && (
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
              <Button kind="ghost" disabled={busy} onClick={() => void write(form, null)}>
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
  const [stale, setStale] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const title = t("profiling.assessment.title");
  const writable = view.capabilities.writeAssessment;

  async function show() {
    setBusy(true);
    setFailed(false);
    setStale(false);
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
    setStale(false);
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
      saved(data.profiling);
      // The save's own revision goes with the values it stored, never a later one of the record.
      setLoaded({ ...loaded, revision: data.revision });
      showToast({ title: t("profiling.assessment.saved") });
    } catch (error) {
      const { status, codes } = codesAt(error);
      if (status === 409) {
        // The input stays; "Neu laden" takes the stored state instead.
        setStale(true);
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
        onHide={() => {
          setLoaded(undefined);
          setStale(false);
        }}
      />
      {stale && (
        <ReloadNotice title={t("profiling.assessment.stale")} onReload={() => void show()} />
      )}
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
                      readOnly={!writable}
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
              readOnly={!writable}
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
              readOnly={!writable}
              value={loaded.form.nextSteps}
              onChange={(event) =>
                setLoaded({ ...loaded, form: { ...loaded.form, nextSteps: event.target.value } })
              }
              {...invalid("/values/nextSteps")}
            />
            {writable && (
              <div>
                <Button type="submit" disabled={busy}>
                  {t("profiling.assessment.save")}
                </Button>
              </div>
            )}
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
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const { lineKey: key, line, onChange, invalid, readOnly } = props;
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
            disabled={readOnly}
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
              readOnly={readOnly}
              value={line.label}
              onChange={(event) => onChange({ label: event.target.value })}
              {...invalid(`/values/${key}/label`)}
            />
          )}
          <TextInput
            id={`assessment-${key}-text`}
            labelText={`${name}: ${t("profiling.assessment.text")}`}
            maxLength={300}
            readOnly={readOnly}
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
type Declarations = { jobboerseChoice: Choice; baContactConsent: boolean | null };

const declarationsOf = (view: View): Declarations => ({
  jobboerseChoice: view.declarations?.jobboerseChoice ?? null,
  baContactConsent: view.declarations?.baContactConsent ?? null,
});
const sameDeclarations = (a: Declarations, b: Declarations) =>
  a.jobboerseChoice === b.jobboerseChoice && a.baContactConsent === b.baContactConsent;

function DeclarationsSection({ view }: { view: View }) {
  const { t } = useTranslation();
  const api = useApi();
  const showToast = useToast();
  const { saved, reload } = useSaved(view.participationId);
  const { draft, setDraft, conflict, token, adopt } = useDraft(
    { revision: view.revision, value: declarationsOf(view) },
    sameDeclarations,
  );
  const [failure, setFailure] = useState<"failed" | "stale">();
  const writable = view.capabilities.record;
  const save = useMutation({
    mutationFn: async () => {
      const { data } = await api.PUT(
        "/api/v1/participations/{participationId}/profiling/declarations",
        {
          params: { path: { participationId: view.participationId } },
          body: { revision: token, ...draft },
        },
      );
      if (!data) throw new Error("No profiling");
      return data;
    },
    onSuccess: ({ profiling }) => {
      showToast({ title: t("profiling.declarations.saved") });
      adopt({ revision: profiling.revision, value: declarationsOf(profiling) });
      saved(profiling);
    },
    onError: async (error) => {
      if (codesAt(error).status !== 409) return setFailure("failed");
      setFailure("stale");
      await reload();
    },
  });
  const choices = ["full", "anonymous_callme", "anonymous_no_contact", "none"] as const;
  const recordedAt = view.declarations?.recordedAt;
  return (
    <section className="tp-section" aria-labelledby="profiling-declarations">
      <h2 id="profiling-declarations">{t("profiling.declarations.title")}</h2>
      <p>{t("profiling.declarations.intro")}</p>
      <Form
        className="tp-form"
        onSubmit={(event) => {
          event.preventDefault();
          setFailure(undefined);
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
          {conflict && (
            <ReloadNotice
              title={t("profiling.draft.conflict")}
              onReload={() => {
                setFailure(undefined);
                adopt({ revision: view.revision, value: declarationsOf(view) });
              }}
            />
          )}
          <Select
            id="declarations-jobboerse"
            labelText={t("profiling.declarations.jobboerse")}
            value={draft.jobboerseChoice ?? "open"}
            disabled={!writable}
            onChange={(event) =>
              setDraft({
                ...draft,
                jobboerseChoice:
                  event.target.value === "open" ? null : (event.target.value as Choice),
              })
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
            disabled={!writable}
            valueSelected={
              draft.baContactConsent === null ? "open" : draft.baContactConsent ? "yes" : "no"
            }
            onChange={(value) =>
              setDraft({ ...draft, baContactConsent: value === "open" ? null : value === "yes" })
            }
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
          {recordedAt && (
            <p className="tp-hint">
              {t("profiling.declarations.recordedAt", { at: formatTimestamp(recordedAt) })}
            </p>
          )}
          {writable && (
            <div>
              <Button type="submit" disabled={save.isPending}>
                {t("profiling.declarations.save")}
              </Button>
            </div>
          )}
        </Stack>
      </Form>
    </section>
  );
}
