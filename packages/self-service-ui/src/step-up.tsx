import { useQuery } from "@tanstack/react-query";
import { ApiProblemError } from "@transfer/api-client";
import type { SensitiveStepUpMethod } from "@transfer/domain";
import {
  Button,
  DateField,
  Form,
  InlineNotification,
  RadioButton,
  RadioButtonGroup,
  Stack,
  TextInput,
  parseDisplayDate,
} from "@transfer/ui";
import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SELF_SERVICE_NAMESPACE } from "./i18n";
import type { Step } from "./model";
import { failureOf, type StepUpSource } from "./source";

// The step-up before the special-category page (ADR-0007, step-up; Q137): once per session, the
// birth date again for an account assured by it, else a step-up code to a channel the participant
// picks. Until it is done the page shows only this; it may be skipped.

type Problem =
  | "wrongBirthDate"
  | "wrongCode"
  | "rateLimited"
  | "failed"
  | "dateInvalid"
  | "chooseChannel";

/** The code of a refused step-up request, for the message to show. */
function problemOf(error: unknown): Problem | "expired" | "ended" {
  if (failureOf(error).kind === "expired") return "expired";
  if (!(error instanceof ApiProblemError)) return "failed";
  const code = error.problem.errors?.[0]?.code;
  if (code === "step_up_failed") return "ended";
  if (code === "knowledge_check_failed") return "wrongBirthDate";
  if (code === "one_time_code_invalid") return "wrongCode";
  if (error.status === 429) return "rateLimited";
  return "failed";
}

export function StepUp(props: {
  stepUp: StepUpSource;
  method: SensitiveStepUpMethod;
  language: "de" | "en";
  heading: ReactNode;
  onDone: () => void;
  /** The fifth wrong birth date ended the session. */
  onEnded: () => void;
  onExpired: () => void;
  previous: Step | undefined;
  next: Step;
  onStep: (step: Step) => void;
}) {
  const { t } = useTranslation(SELF_SERVICE_NAMESPACE);
  const [problem, setProblem] = useState<Problem>();
  const [busy, setBusy] = useState(false);

  /** Runs a step-up request; a refusal shows its message or ends the view. */
  async function attempt(request: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    try {
      await request();
      setProblem(undefined);
      after?.();
    } catch (error) {
      const outcome = problemOf(error);
      if (outcome === "ended") props.onEnded();
      else if (outcome === "expired") props.onExpired();
      else setProblem(outcome);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack gap={6}>
      <Stack gap={3}>
        {props.heading}
        <p>{t("stepUp.intro")}</p>
      </Stack>
      {problem && (
        <InlineNotification
          kind="error"
          title={t(`stepUp.${problem}`)}
          role="alert"
          hideCloseButton
          lowContrast
        />
      )}
      {props.method === "birth_date" ? (
        <BirthDate busy={busy} onProblem={setProblem} attempt={attempt} {...props} />
      ) : (
        <Code busy={busy} onProblem={setProblem} attempt={attempt} {...props} />
      )}
      <div className="tp-wizard-actions">
        {props.previous && (
          <Button kind="secondary" disabled={busy} onClick={() => props.onStep(props.previous!)}>
            {t("actions.back")}
          </Button>
        )}
        <Button kind="ghost" disabled={busy} onClick={() => props.onStep(props.next)}>
          {t("stepUp.skip")}
        </Button>
      </div>
    </Stack>
  );
}

type Attempt = (request: () => Promise<unknown>, after?: () => void) => Promise<void>;
type Part = {
  stepUp: StepUpSource;
  language: "de" | "en";
  busy: boolean;
  onProblem: (problem: Problem) => void;
  attempt: Attempt;
  onDone: () => void;
};

function BirthDate(props: Part) {
  const { t } = useTranslation(SELF_SERVICE_NAMESPACE);
  const [value, setValue] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = parseDisplayDate(value);
    if (!parsed.ok || !parsed.value) {
      props.onProblem("dateInvalid");
      return;
    }
    void props.attempt(() => props.stepUp.birthDate(parsed.value!), props.onDone);
  }
  return (
    <Form onSubmit={submit} noValidate>
      <Stack gap={5}>
        <DateField
          id="self-service-step-up-birth-date"
          labelText={t("stepUp.birthDate")}
          defaultValue=""
          onChange={setValue}
        />
        <div>
          <Button type="submit" disabled={props.busy}>
            {t("stepUp.confirm")}
          </Button>
        </div>
      </Stack>
    </Form>
  );
}

function Code(props: Part) {
  const { t } = useTranslation(SELF_SERVICE_NAMESPACE);
  const channels = useQuery({
    queryKey: ["self-service", "step-up", "channels"],
    queryFn: () => props.stepUp.channels(),
    retry: false,
  });
  const [channelId, setChannelId] = useState<string>();
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");

  if (channels.isPending) return <p>{t("loading")}</p>;
  if (channels.isError) {
    return <InlineNotification kind="error" title={t("loadFailed")} hideCloseButton />;
  }
  const chosen = channelId ?? channels.data[0]?.id;

  function send() {
    if (!chosen) {
      props.onProblem("chooseChannel");
      return;
    }
    void props.attempt(
      () => props.stepUp.requestCode(chosen, props.language),
      () => setSent(true),
    );
  }
  function verify(event: FormEvent) {
    event.preventDefault();
    void props.attempt(() => props.stepUp.verifyCode(code.trim()), props.onDone);
  }

  return (
    <Stack gap={5}>
      <RadioButtonGroup
        legendText={t("stepUp.channel")}
        name="self-service-step-up-channel"
        valueSelected={chosen}
        onChange={(value) => setChannelId(String(value))}
        orientation="vertical"
      >
        {channels.data.map((channel) => (
          <RadioButton
            key={channel.id}
            id={`self-service-step-up-channel-${channel.id}`}
            labelText={channel.maskedAddress}
            value={channel.id}
          />
        ))}
      </RadioButtonGroup>
      <div>
        <Button kind={sent ? "tertiary" : "primary"} disabled={props.busy} onClick={send}>
          {t(sent ? "stepUp.sendAgain" : "stepUp.send")}
        </Button>
      </div>
      {sent && (
        <Form onSubmit={verify} noValidate>
          <Stack gap={5}>
            <output>{t("stepUp.sent")}</output>
            <TextInput
              id="self-service-step-up-code"
              labelText={t("stepUp.code")}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
            />
            <div>
              <Button type="submit" disabled={props.busy}>
                {t("stepUp.confirm")}
              </Button>
            </div>
          </Stack>
        </Form>
      )}
    </Stack>
  );
}
