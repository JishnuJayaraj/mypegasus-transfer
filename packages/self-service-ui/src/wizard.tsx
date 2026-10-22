import { useQuery, useQueryClient } from "@tanstack/react-query";
import { organisation } from "@transfer/config";
import {
  groupNeedsStepUp,
  selfServicePurposesNotice,
  type ConfidentialPage,
  type SensitivePage,
  type WizardPage,
} from "@transfer/domain";
import {
  Button,
  Form as CarbonForm,
  InlineNotification,
  ProgressBar,
  Stack,
  formatDate,
} from "@transfer/ui";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { FieldEditor, Form } from "./fields";
import { SELF_SERVICE_NAMESPACE } from "./i18n";
import {
  currentStep,
  nextStep,
  pageDraft,
  pageSubmission,
  previousStep,
  progress,
  type Draft,
  type Issue,
  type SensitiveValues,
  type Step,
  type WizardState,
} from "./model";
import { failureOf, type SelfServiceSource } from "./source";
import { StepUp } from "./step-up";

// The self-service wizard (regional-variation.md, "Self-service wizard"; data-protection.md,
// self-service): the purposes notice first, then one page at a time, each saved whole on "Weiter"
// with the revision read; the overview lists what is still missing. Rendered from the API's page
// definitions, so requirements, help texts and custom fields follow the participation's chain.
// A sensitive page reads and writes its group on its own logged routes; the special-category page
// shows only the step-up until the session has it (ADR-0007, step-up).

type Message = "stale" | "invalid" | "failed" | "closed" | "newVersion";

export interface SelfServiceWizardProps {
  source: SelfServiceSource;
  /** The step asked for (e.g. from the URL); without one the wizard resumes. */
  step: string | undefined;
  onStep: (step: Step) => void;
  /** Shown when the session has ended: the app's way back to its login. */
  expired: ReactNode;
}

const useT = () => useTranslation(SELF_SERVICE_NAMESPACE);

export function SelfServiceWizard(props: SelfServiceWizardProps) {
  const { t, i18n } = useT();
  const language = i18n.resolvedLanguage === "en" ? "en" : "de";
  const { source, onStep } = props;
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<Message>();
  const [ended, setEnded] = useState<"expired" | "step_up_failed">();
  const [moved, setMoved] = useState(false);
  const [busy, setBusy] = useState(false);
  // A reload after a conflict starts the page again from what was loaded.
  const [generation, setGeneration] = useState(0);
  const query = useQuery({ queryKey: source.queryKey, queryFn: () => source.load(), retry: false });

  if (ended || (query.isError && failureOf(query.error).kind === "expired")) {
    return (
      <Stack gap={5}>
        {ended === "step_up_failed" && (
          <InlineNotification kind="error" title={t("stepUp.ended")} hideCloseButton lowContrast />
        )}
        {props.expired}
      </Stack>
    );
  }
  if (query.isPending) return <p>{t("loading")}</p>;
  if (query.isError) {
    return <InlineNotification kind="error" title={t("loadFailed")} hideCloseButton />;
  }
  const state = query.data;
  const step = currentStep(state, props.step);

  const reload = async (reason: Message) => {
    await query.refetch();
    setGeneration((value) => value + 1);
    setMessage(reason);
  };

  async function acknowledge() {
    setBusy(true);
    try {
      await source.acknowledge(language);
      setMessage(undefined);
      setMoved(true);
      await query.refetch();
    } catch (error) {
      if (failureOf(error).kind === "expired") setEnded("expired");
      else setMessage("failed");
    } finally {
      setBusy(false);
    }
  }

  async function save(page: WizardPage, values: Record<string, unknown>): Promise<Issue[]> {
    try {
      const input = { revision: state.revision, values };
      const { warnings: _, ...next } = page.sensitive
        ? await source.saveSensitive(page.page as SensitivePage, input)
        : await source.save(page.page as ConfidentialPage, input);
      // Decrypted values are read again when the page opens, never kept (data-protection.md).
      queryClient.removeQueries({ queryKey: [...source.queryKey, "sensitive"] });
      queryClient.setQueryData<WizardState>(source.queryKey, next);
      setMessage(undefined);
      setMoved(true);
      onStep(nextStep(next, page.page));
      return [];
    } catch (error) {
      const failure = failureOf(error);
      switch (failure.kind) {
        case "invalid":
          setMessage("invalid");
          return failure.issues;
        case "expired":
          setEnded("expired");
          return [];
        case "step_up_required":
          await query.refetch();
          return [];
        case "stale":
          await reload("stale");
          return [];
        case "notice_required":
          await reload("newVersion");
          return [];
        default:
          setMessage(failure.kind);
          return [];
      }
    }
  }

  const notification = message && (
    <InlineNotification
      kind={message === "stale" || message === "newVersion" ? "warning" : "error"}
      title={t(message === "newVersion" ? "notice.newVersion" : `messages.${message}`)}
      hideCloseButton
      lowContrast
    />
  );

  if (step === "notice") {
    const notice = selfServicePurposesNotice(language, organisation);
    return (
      <Stack gap={5}>
        {notification}
        <article className="tp-notice-text">
          <Heading>{notice.title}</Heading>
          {notice.text.split("\n\n").map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </article>
        <Button disabled={busy} onClick={() => void acknowledge()}>
          {t("notice.acknowledge")}
        </Button>
      </Stack>
    );
  }

  const current = state.pages.find((page) => page.page === step)!;
  const go = (next: Step) => {
    setMessage(undefined);
    setMoved(true);
    onStep(next);
  };

  return (
    <Moved.Provider value={moved}>
      <Stack gap={6}>
        <Progress state={state} />
        {notification}
        {step === "overview" ? (
          <Overview state={state} onStep={go} />
        ) : current.sensitive &&
          groupNeedsStepUp(current.page as SensitivePage) &&
          state.stepUp &&
          !state.stepUp.done &&
          source.stepUp ? (
          <StepUp
            stepUp={source.stepUp}
            method={state.stepUp.method}
            language={language}
            heading={<Heading>{t(`pages.${current.page}`)}</Heading>}
            onDone={() => void query.refetch()}
            onEnded={() => setEnded("step_up_failed")}
            onExpired={() => setEnded("expired")}
            previous={previousStep(state, current.page)}
            next={nextStep(state, current.page)}
            onStep={go}
          />
        ) : current.sensitive ? (
          <SensitiveStep
            key={`${step}:${state.revision}:${generation}`}
            group={current.page as SensitivePage}
            source={source}
            onExpired={() => setEnded("expired")}
            onStepUp={() => void query.refetch()}
          >
            {(values) => (
              <PageStep
                state={state}
                page={current}
                sensitive={values}
                language={language}
                onSave={save}
                onInvalid={() => setMessage("invalid")}
                onStep={go}
              />
            )}
          </SensitiveStep>
        ) : (
          <PageStep
            key={`${step}:${state.revision}:${generation}`}
            state={state}
            page={current}
            language={language}
            onSave={save}
            onInvalid={() => setMessage("invalid")}
            onStep={go}
          />
        )}
      </Stack>
    </Moved.Provider>
  );
}

/** Whether the participant has moved between steps here (not the first load). */
const Moved = createContext(false);

/** The step's heading, focused when the participant moves to it, so a screen reader starts there. */
function Heading({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  const moved = useContext(Moved);
  useEffect(() => {
    if (moved) ref.current?.focus();
  }, [moved]);
  return (
    <h1 ref={ref} tabIndex={-1}>
      {children}
    </h1>
  );
}

function Progress({ state }: { state: WizardState }) {
  const { t } = useT();
  const { complete, total } = progress(state);
  return (
    <ProgressBar
      label={t("progress.label")}
      helperText={t("progress.pages", { complete, total })}
      value={complete}
      max={total}
    />
  );
}

/**
 * Reads a sensitive group on its own logged route each time its page opens; the values live only
 * in the page's form (never cached).
 */
function SensitiveStep(props: {
  group: SensitivePage;
  source: SelfServiceSource;
  onExpired: () => void;
  onStepUp: () => void;
  children: (values: SensitiveValues) => ReactNode;
}) {
  const { t } = useT();
  const { source, group } = props;
  const query = useQuery({
    queryKey: [...source.queryKey, "sensitive", group],
    queryFn: () => source.loadSensitive(group),
    retry: false,
    gcTime: 0,
  });
  const failure = query.isError ? failureOf(query.error).kind : undefined;
  // Once per failure: the wizard then shows the login or the step-up instead of this page.
  const { onExpired, onStepUp } = props;
  const handled = useRef<string>(undefined);
  useEffect(() => {
    if (!failure || handled.current === failure) return;
    handled.current = failure;
    if (failure === "expired") onExpired();
    if (failure === "step_up_required") onStepUp();
  }, [failure, onExpired, onStepUp]);
  if (query.isPending) return <p>{t("loading")}</p>;
  if (query.isError) {
    return <InlineNotification kind="error" title={t("loadFailed")} hideCloseButton />;
  }
  return <>{props.children(query.data.values)}</>;
}

function PageStep(props: {
  state: WizardState;
  page: WizardPage;
  sensitive?: SensitiveValues;
  language: "de" | "en";
  onSave: (page: WizardPage, values: Record<string, unknown>) => Promise<Issue[]>;
  onInvalid: () => void;
  onStep: (step: Step) => void;
}) {
  const { t } = useT();
  const { state, page } = props;
  const [draft, setDraft] = useState<Draft>(() => pageDraft(page, state, props.sensitive));
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);
  const { warnings } = useMemo(() => pageSubmission(page, draft), [page, draft]);
  const { pages } = state;
  const index = pages.findIndex((candidate) => candidate.page === page.page);
  const previous = previousStep(state, page.page);

  const errorText = (code: string) => t(`errors.${code}`, { defaultValue: t("errors.invalid") });
  const context = {
    draft,
    set: (key: string, value: unknown) => setDraft((current) => ({ ...current, [key]: value })),
    error: (path: string) => {
      const issue = issues.find((candidate) => candidate.path === path);
      return issue && errorText(issue.code);
    },
    warnings,
    language: props.language,
  };
  // Issues without an input of their own (e.g. the page as a whole) are listed above the fields.
  const unplaced = issues.filter((issue) => issue.path === "");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const submission = pageSubmission(page, draft);
    if (submission.issues.length > 0) {
      setIssues(submission.issues);
      props.onInvalid();
      return;
    }
    setBusy(true);
    try {
      setIssues(await props.onSave(page, submission.values));
    } finally {
      setBusy(false);
    }
  }

  return (
    <CarbonForm onSubmit={(event: FormEvent) => void submit(event)} noValidate>
      <Stack gap={6}>
        <Stack gap={3}>
          <p className="tp-hint">
            {t("progress.step", { current: index + 1, total: pages.length })}
          </p>
          <Heading>{t(`pages.${page.page}`)}</Heading>
          <p>{t("intro.required")}</p>
          <p>{t("intro.optional")}</p>
          <p>{t(page.page === "health" ? "intro.yesNoOnly" : "intro.noDiagnoses")}</p>
        </Stack>
        {unplaced.map((issue) => (
          <p key={issue.code} className="tp-error" role="alert">
            {errorText(issue.code)}
          </p>
        ))}
        {page.page === "contact" && <Identity state={state} />}
        <Form.Provider value={context}>
          {page.fields.map((field) => (
            <FieldEditor key={field.key} field={field} />
          ))}
        </Form.Provider>
        <div className="tp-wizard-actions">
          {previous && (
            <Button kind="secondary" disabled={busy} onClick={() => props.onStep(previous)}>
              {t("actions.back")}
            </Button>
          )}
          <Button type="submit" disabled={busy}>
            {t("actions.next")}
          </Button>
        </div>
      </Stack>
    </CarbonForm>
  );
}

/** Names and birth date come from the import: shown, never edited here (Q112). */
function Identity({ state }: { state: WizardState }) {
  const { t } = useT();
  const { firstName, lastName, birthDate } = state.identity;
  return (
    <Stack gap={3}>
      <p>{t("identity.intro")}</p>
      <dl className="tp-facts">
        <div>
          <dt>{t("identity.name")}</dt>
          <dd>{`${firstName} ${lastName}`}</dd>
        </div>
        {birthDate && (
          <div>
            <dt>{t("identity.birthDate")}</dt>
            <dd>{formatDate(birthDate)}</dd>
          </div>
        )}
      </dl>
    </Stack>
  );
}

/** Every page with what is still missing on it (codes as labels), and a way back to it. */
function Overview({ state, onStep }: { state: WizardState; onStep: (step: Step) => void }) {
  const { t, i18n } = useT();
  const language = i18n.resolvedLanguage === "en" ? "en" : "de";
  const labelOf = (page: WizardPage, key: string) => {
    const custom = page.fields.find((field) => field.key === key)?.custom;
    return custom ? (custom.label[language] ?? custom.label.de) : t(`fields.${key}.label`);
  };
  return (
    <Stack gap={6}>
      <Stack gap={3}>
        <Heading>{t("overview.title")}</Heading>
        <p>{t("overview.intro")}</p>
      </Stack>
      <ul className="tp-overview">
        {state.pages.map((page) => {
          const missing = [
            ...new Set(
              state.missing
                .filter((item) => page.fields.some((field) => field.key === item.key))
                .map((item) => item.key),
            ),
          ];
          return (
            <li key={page.page}>
              <Stack gap={3}>
                <h2>{t(`pages.${page.page}`)}</h2>
                {missing.length === 0 ? (
                  <p>{t("overview.complete")}</p>
                ) : (
                  <>
                    <p>{t("overview.missing", { count: missing.length })}</p>
                    <ul className="tp-list">
                      {missing.map((key) => (
                        <li key={key}>{labelOf(page, key)}</li>
                      ))}
                    </ul>
                  </>
                )}
                <div>
                  <Button kind="tertiary" size="sm" onClick={() => onStep(page.page)}>
                    {t("actions.edit", { page: t(`pages.${page.page}`) })}
                  </Button>
                </div>
              </Stack>
            </li>
          );
        })}
      </ul>
    </Stack>
  );
}
