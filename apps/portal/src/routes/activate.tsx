import { createFileRoute, Link, useLocation, useNavigate } from "@tanstack/react-router";
import { ApiProblemError } from "@transfer/api-client";
import { organisation } from "@transfer/config";
import {
  ART14_NOTICE_VERSION,
  PORTAL_CONTACT_CONSENT_VERSION,
  art14Notice,
  type ActivationState,
  type ContactKind,
  type NoticeLanguage,
} from "@transfer/domain";
import {
  Button,
  Form,
  InlineNotification,
  RadioButton,
  RadioButtonGroup,
  Stack,
  TextInput,
  parseDisplayDate,
} from "@transfer/ui";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Consent } from "../components/consent";

export const Route = createFileRoute("/activate")({ component: Activate });

type Step = "code" | "notice" | ActivationState["nextStep"] | "done";

/** The refusals the portal explains; anything else is `failed` (never a raw code on screen). */
const errorKeys = [
  "code_invalid",
  "before_cutoff",
  "knowledge_check_failed",
  "one_time_code_invalid",
  "rate_limited",
  "channel_in_use",
  "channel_invalid",
  "delivery_failed",
  "delivery_unavailable",
  "step_not_allowed",
  "session_expired",
  "birth_date_format",
  "failed",
] as const;
type ErrorKey = (typeof errorKeys)[number];
const isErrorKey = (code: string | undefined): code is ErrorKey =>
  (errorKeys as readonly (string | undefined)[]).includes(code);

type Answer<T> = { data?: T };

/**
 * The activation (Slice 3 plan D22, D23): the code from the link's fragment (moved into memory and
 * removed from the address bar, posted only on a click), the notice, the birth date, then the
 * retyped delivery address of an in-person code or a private email or mobile with a one-time code.
 * Codes and addresses live only in this component's state.
 */
function Activate() {
  const { t, i18n } = useTranslation();
  const { api } = Route.useRouteContext();
  const location = useLocation();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("code");
  const [state, setState] = useState<ActivationState>();
  const [code, setCode] = useState("");
  const [error, setError] = useState<ErrorKey>();
  const [busy, setBusy] = useState(false);
  const language: NoticeLanguage = i18n.resolvedLanguage === "en" ? "en" : "de";

  // D22: the code arrives in the fragment, which the server never sees; it leaves the address bar
  // at once and is posted only when the participant clicks.
  useEffect(() => {
    if (location.hash) {
      setCode(location.hash);
      void navigate({ to: "/activate", hash: "", replace: true });
    }
    // Only the fragment of the page as it was opened.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Sends one request; a refusal shows its message, an expired session starts over. */
  async function send<T>(
    request: Promise<Answer<T>>,
    onDone: (data: T) => void | Promise<void>,
  ): Promise<boolean> {
    setBusy(true);
    setError(undefined);
    try {
      const { data } = await request;
      if (data === undefined) throw new Error("No data");
      await onDone(data);
      return true;
    } catch (failure) {
      // Problems reject with their RFC 9457 body (the API client); never shown raw.
      const reason =
        failure instanceof ApiProblemError
          ? failure.status === 401
            ? "session_expired"
            : failure.problem.errors?.[0]?.code
          : undefined;
      setError(isErrorKey(reason) ? reason : "failed");
      if (reason === "session_expired" || reason === "code_invalid") {
        setState(undefined);
        setStep("code");
      }
    } finally {
      setBusy(false);
    }
    return false;
  }

  const advance = (next: ActivationState) => {
    setState(next);
    setStep(next.nextStep);
  };

  const complete = (verification: { oneTimeCode: string } | { deliveryAddress: string }) =>
    send(
      api.POST("/api/v1/portal/activation/completion", {
        body: {
          ...verification,
          noticeVersion: ART14_NOTICE_VERSION,
          consent: true,
          consentVersion: PORTAL_CONTACT_CONSENT_VERSION,
          language,
        },
      }),
      () => setStep("done"),
    );

  return (
    <Stack gap={6}>
      <h1>{t("activate.title")}</h1>
      {error && (
        <InlineNotification
          kind="error"
          title={t(`activate.errors.${error}`, { contact: organisation.controllerEmail })}
          hideCloseButton
          lowContrast
        />
      )}
      {step === "code" && (
        <CodeStep
          code={code}
          onChange={setCode}
          busy={busy}
          onSubmit={() =>
            send(api.POST("/api/v1/portal/activation", { body: { code } }), async (started) => {
              setCode("");
              setState(started);
              await i18n.changeLanguage(started.language);
              setStep("notice");
            })
          }
        />
      )}
      {step === "notice" && state && (
        <NoticeStep language={language} onContinue={() => setStep(state.nextStep)} />
      )}
      {step === "birth_date" && (
        <BirthDateStep
          busy={busy}
          onInvalid={() => setError("birth_date_format")}
          onSubmit={(birthDate) =>
            send(api.POST("/api/v1/portal/activation/birth-date", { body: { birthDate } }), advance)
          }
        />
      )}
      {(step === "delivery_address" || step === "complete") && state?.deliveryKind && (
        <DeliveryAddressStep
          kind={state.deliveryKind}
          language={language}
          busy={busy}
          onSubmit={async (deliveryAddress) => {
            // The check counts a mismatch (D14); a match lets the same address complete.
            const checked =
              step === "complete" ||
              (await send(
                api.POST("/api/v1/portal/activation/delivery-address", {
                  body: { deliveryAddress },
                }),
                advance,
              ));
            if (checked) await complete({ deliveryAddress });
          }}
        />
      )}
      {(step === "channel" || step === "one_time_code") && (
        <ChannelSteps
          step={step}
          language={language}
          busy={busy}
          onSend={(kind, address) =>
            send(
              api.POST("/api/v1/portal/activation/channel", { body: { kind, address, language } }),
              advance,
            )
          }
          onConfirm={(oneTimeCode) => complete({ oneTimeCode })}
        />
      )}
      {step === "done" && (
        <Stack gap={5}>
          <h2>
            {state?.purpose === "recovery"
              ? t("activate.done.recoveredTitle")
              : t("activate.done.title")}
          </h2>
          <p>
            {state?.purpose === "recovery"
              ? t("activate.done.recoveredText")
              : t("activate.done.text")}
          </p>
          <Link to="/">{t("activate.done.home")}</Link>
        </Stack>
      )}
    </Stack>
  );
}

function StepForm({ onSubmit, children }: { onSubmit: () => unknown; children: ReactNode }) {
  return (
    <Form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void onSubmit();
      }}
    >
      <Stack gap={5}>{children}</Stack>
    </Form>
  );
}

function CodeStep(props: {
  code: string;
  onChange: (code: string) => void;
  busy: boolean;
  onSubmit: () => unknown;
}) {
  const { t } = useTranslation();
  return (
    <StepForm onSubmit={props.onSubmit}>
      <p>{t("activate.code.intro")}</p>
      <TextInput
        id="activation-code"
        labelText={t("activate.code.label")}
        helperText={t("activate.code.help")}
        value={props.code}
        onChange={(event) => props.onChange(event.target.value)}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
      />
      <Button type="submit" disabled={props.busy || props.code.trim() === ""}>
        {t("activate.code.submit")}
      </Button>
    </StepForm>
  );
}

/** D18: the Art. 14 notice is repeated here (never its first delivery); the version is recorded. */
function NoticeStep({
  language,
  onContinue,
}: {
  language: NoticeLanguage;
  onContinue: () => void;
}) {
  const { t } = useTranslation();
  const notice = art14Notice(language, organisation);
  return (
    <Stack gap={5}>
      <article className="tp-notice">
        <h2>{notice.title}</h2>
        {notice.text.split("\n\n").map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </article>
      <Button onClick={onContinue}>{t("activate.notice.continue")}</Button>
    </Stack>
  );
}

function BirthDateStep(props: {
  busy: boolean;
  onInvalid: () => void;
  onSubmit: (birthDate: string) => unknown;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  return (
    <StepForm
      onSubmit={() => {
        const parsed = parseDisplayDate(text);
        if (!parsed.ok || !parsed.value) return props.onInvalid();
        return props.onSubmit(parsed.value);
      }}
    >
      <p>{t("activate.birthDate.intro")}</p>
      <TextInput
        id="birth-date"
        labelText={t("activate.birthDate.label")}
        placeholder={t("activate.birthDate.placeholder")}
        value={text}
        onChange={(event) => setText(event.target.value)}
        inputMode="numeric"
        autoComplete="bday"
      />
      <Button type="submit" disabled={props.busy || text.trim() === ""}>
        {t("activate.next")}
      </Button>
    </StepForm>
  );
}

function DeliveryAddressStep(props: {
  kind: ContactKind;
  language: NoticeLanguage;
  busy: boolean;
  onSubmit: (address: string) => unknown;
}) {
  const { t } = useTranslation();
  const [address, setAddress] = useState("");
  const [consent, setConsent] = useState(false);
  return (
    <StepForm onSubmit={() => props.onSubmit(address)}>
      <p>
        {t(props.kind === "email" ? "activate.address.introEmail" : "activate.address.introSms")}
      </p>
      <TextInput
        id="delivery-address"
        labelText={t(props.kind === "email" ? "activate.channel.email" : "activate.channel.sms")}
        value={address}
        onChange={(event) => setAddress(event.target.value)}
        type={props.kind === "email" ? "email" : "tel"}
        autoComplete={props.kind === "email" ? "email" : "tel"}
      />
      <Consent language={props.language} checked={consent} onChange={setConsent} />
      <Button type="submit" disabled={props.busy || !consent || address.trim() === ""}>
        {t("activate.complete")}
      </Button>
    </StepForm>
  );
}

function ChannelSteps(props: {
  step: "channel" | "one_time_code";
  language: NoticeLanguage;
  busy: boolean;
  onSend: (kind: ContactKind, address: string) => unknown;
  onConfirm: (oneTimeCode: string) => unknown;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<ContactKind>("email");
  const [address, setAddress] = useState("");
  const [consent, setConsent] = useState(false);
  const [oneTimeCode, setOneTimeCode] = useState("");
  if (props.step === "one_time_code") {
    return (
      <StepForm onSubmit={() => props.onConfirm(oneTimeCode.trim())}>
        <p>
          {t(
            kind === "email" ? "activate.oneTimeCode.introEmail" : "activate.oneTimeCode.introSms",
          )}
        </p>
        <TextInput
          id="one-time-code"
          labelText={t("activate.oneTimeCode.label")}
          value={oneTimeCode}
          onChange={(event) => setOneTimeCode(event.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
        />
        <Button type="submit" disabled={props.busy || !/^\d{6}$/.test(oneTimeCode.trim())}>
          {t("activate.complete")}
        </Button>
        <Button kind="ghost" disabled={props.busy} onClick={() => props.onSend(kind, address)}>
          {t("activate.oneTimeCode.resend")}
        </Button>
      </StepForm>
    );
  }
  return (
    <StepForm onSubmit={() => props.onSend(kind, address)}>
      <p>{t("activate.channel.intro")}</p>
      <RadioButtonGroup
        legendText={t("activate.channel.kind")}
        name="channel-kind"
        valueSelected={kind}
        onChange={(value) => setKind(value as ContactKind)}
        orientation="vertical"
      >
        <RadioButton id="channel-email" labelText={t("activate.channel.kindEmail")} value="email" />
        <RadioButton id="channel-sms" labelText={t("activate.channel.kindSms")} value="sms" />
      </RadioButtonGroup>
      <TextInput
        id="channel-address"
        labelText={t(kind === "email" ? "activate.channel.email" : "activate.channel.sms")}
        helperText={t("activate.channel.help")}
        value={address}
        onChange={(event) => setAddress(event.target.value)}
        type={kind === "email" ? "email" : "tel"}
        autoComplete={kind === "email" ? "email" : "tel"}
      />
      <Consent language={props.language} checked={consent} onChange={setConsent} />
      <Button type="submit" disabled={props.busy || !consent || address.trim() === ""}>
        {t("activate.channel.send")}
      </Button>
    </StepForm>
  );
}
