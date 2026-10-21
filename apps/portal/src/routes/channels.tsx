import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { PORTAL_CONTACT_CONSENT_VERSION, type ContactKind, type PortalMe } from "@transfer/domain";
import {
  Button,
  Form,
  InlineNotification,
  RadioButton,
  RadioButtonGroup,
  Stack,
  TextInput,
  formatTimestamp,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Consent } from "../components/consent";
import { submitWith } from "../forms";
import { messageLanguage, problemCode } from "../problem";

export const Route = createFileRoute("/channels")({ component: Channels });

/** The refusals the page explains; anything else is `failed`. */
const errorKeys = [
  "one_time_code_invalid",
  "rate_limited",
  "channel_in_use",
  "channel_invalid",
  "delivery_failed",
  "delivery_unavailable",
  "session_expired",
  "failed",
] as const;
type ErrorKey = (typeof errorKeys)[number];
const isErrorKey = (code: string | undefined): code is ErrorKey =>
  (errorKeys as readonly (string | undefined)[]).includes(code);

/**
 * The participant's channels (Q123): each masked, with its removal (its consent ends;
 * the last one ends the session, so the page warns first) and the addition of a private email or
 * mobile, verified by a one-time code, with its own consent. Never the work email.
 */
function Channels() {
  const { t, i18n } = useTranslation();
  const { api } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const [error, setError] = useState<ErrorKey>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string>();
  const [loggedOut, setLoggedOut] = useState(false);
  const language = messageLanguage(i18n.resolvedLanguage);
  const channels = useQuery({
    queryKey: ["portal-channels"],
    queryFn: async () => {
      const { data } = await api.GET("/api/v1/portal/channels");
      if (!data) throw new Error("No portal data");
      return data.channels;
    },
    retry: false,
  });

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      return true;
    } catch (failure) {
      const reason = problemCode(failure);
      setError(isErrorKey(reason) ? reason : "failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const changed = (next: PortalMe["channels"]) => {
    queryClient.setQueryData(["portal-channels"], next);
    void queryClient.invalidateQueries({ queryKey: ["portal-me"] });
  };

  const remove = (channelId: string) =>
    run(async () => {
      const { data } = await api.DELETE("/api/v1/portal/channels/{channelId}", {
        params: { path: { channelId } },
      });
      setConfirming(undefined);
      if (data?.sessionEnded) {
        queryClient.setQueryData(["portal-me"], null);
        queryClient.removeQueries({ queryKey: ["portal-channels"] });
        setLoggedOut(true);
        return;
      }
      changed((channels.data ?? []).filter((channel) => channel.id !== channelId));
    });

  if (loggedOut) {
    return (
      <Stack gap={5}>
        <h1>{t("channels.title")}</h1>
        <InlineNotification kind="info" title={t("channels.loggedOut")} hideCloseButton />
        <Link to="/">{t("activate.done.home")}</Link>
      </Stack>
    );
  }
  if (channels.isPending) return <p>{t("status.checking")}</p>;
  if (channels.isError || error === "session_expired") {
    return (
      <Stack gap={5}>
        <h1>{t("channels.title")}</h1>
        <InlineNotification kind="warning" title={t("channels.expired")} hideCloseButton />
        <Link to="/login">{t("home.login")}</Link>
      </Stack>
    );
  }

  const list = channels.data;
  return (
    <Stack gap={6}>
      <h1>{t("channels.title")}</h1>
      {error && (
        <InlineNotification
          kind="error"
          title={t(`activate.errors.${error}`)}
          hideCloseButton
          lowContrast
        />
      )}
      <ul className="tp-list">
        {list.map((channel) => (
          <li key={channel.id}>
            <Stack gap={3}>
              <span>
                {t(channel.kind === "email" ? "home.channelEmail" : "home.channelSms", {
                  address: channel.maskedAddress,
                  at: formatTimestamp(channel.verifiedAt),
                })}
              </span>
              {confirming === channel.id ? (
                <Stack gap={3}>
                  <InlineNotification
                    kind="warning"
                    title={t(list.length === 1 ? "channels.removeLast" : "channels.removeOne")}
                    hideCloseButton
                    lowContrast
                  />
                  <Stack gap={3}>
                    <Button kind="secondary" onClick={() => setConfirming(undefined)}>
                      {t("channels.cancel")}
                    </Button>
                    <Button kind="danger" disabled={busy} onClick={() => void remove(channel.id)}>
                      {t("channels.confirmRemove")}
                    </Button>
                  </Stack>
                </Stack>
              ) : (
                <Button kind="tertiary" size="sm" onClick={() => setConfirming(channel.id)}>
                  {t("channels.remove")}
                </Button>
              )}
            </Stack>
          </li>
        ))}
      </ul>
      <AddChannel
        busy={busy}
        onSend={(kind, address) =>
          run(async () => {
            await api.POST("/api/v1/portal/channels", { body: { kind, address, language } });
          })
        }
        onConfirm={(oneTimeCode) =>
          run(async () => {
            const { data } = await api.POST("/api/v1/portal/channels/verification", {
              body: {
                oneTimeCode,
                consent: true,
                consentVersion: PORTAL_CONTACT_CONSENT_VERSION,
                language,
              },
            });
            if (!data) throw new Error("No portal data");
            changed(data.channels);
          })
        }
        language={language}
      />
      <Link to="/">{t("activate.done.home")}</Link>
    </Stack>
  );
}

function AddChannel(props: {
  busy: boolean;
  language: "de" | "en";
  onSend: (kind: ContactKind, address: string) => Promise<boolean>;
  onConfirm: (oneTimeCode: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<"address" | "code">("address");
  const [kind, setKind] = useState<ContactKind>("email");
  const [address, setAddress] = useState("");
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState("");
  const reset = () => {
    setStep("address");
    setAddress("");
    setConsent(false);
    setCode("");
  };

  if (step === "code") {
    return (
      <Form
        onSubmit={submitWith(async () => {
          if (await props.onConfirm(code.trim())) reset();
        })}
      >
        <Stack gap={5}>
          <h2>{t("channels.add")}</h2>
          <p>
            {t(
              kind === "email"
                ? "activate.oneTimeCode.introEmail"
                : "activate.oneTimeCode.introSms",
            )}
          </p>
          <TextInput
            id="channel-code"
            labelText={t("activate.oneTimeCode.label")}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
          />
          <Button type="submit" disabled={props.busy || !/^\d{6}$/.test(code.trim())}>
            {t("channels.confirmAdd")}
          </Button>
          <Button
            kind="ghost"
            disabled={props.busy}
            onClick={() => void props.onSend(kind, address)}
          >
            {t("activate.oneTimeCode.resend")}
          </Button>
          <Button kind="ghost" disabled={props.busy} onClick={reset}>
            {t("channels.cancel")}
          </Button>
        </Stack>
      </Form>
    );
  }
  return (
    <Form
      onSubmit={submitWith(async () => {
        if (await props.onSend(kind, address)) setStep("code");
      })}
    >
      <Stack gap={5}>
        <h2>{t("channels.add")}</h2>
        <p>{t("activate.channel.intro")}</p>
        <RadioButtonGroup
          legendText={t("activate.channel.kind")}
          name="new-channel-kind"
          valueSelected={kind}
          onChange={(value) => setKind(value as ContactKind)}
          orientation="vertical"
        >
          <RadioButton
            id="new-channel-email"
            labelText={t("activate.channel.kindEmail")}
            value="email"
          />
          <RadioButton id="new-channel-sms" labelText={t("activate.channel.kindSms")} value="sms" />
        </RadioButtonGroup>
        <TextInput
          id="new-channel-address"
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
      </Stack>
    </Form>
  );
}
