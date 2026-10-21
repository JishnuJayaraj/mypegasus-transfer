import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useLocation, useNavigate } from "@tanstack/react-router";
import { contactKindOf } from "@transfer/domain";
import { Button, Form, InlineNotification, Stack, TextInput } from "@transfer/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { submitWith } from "../forms";
import { messageLanguage, problemCode } from "../problem";

export const Route = createFileRoute("/login")({ component: Login });

/** The refusals the page explains; anything else is `failed`. */
const errorKeys = [
  "one_time_code_invalid",
  "rate_limited",
  "channel_invalid",
  "delivery_unavailable",
  "failed",
] as const;
type ErrorKey = (typeof errorKeys)[number];
const isErrorKey = (code: string | undefined): code is ErrorKey =>
  (errorKeys as readonly (string | undefined)[]).includes(code);

/**
 * The login (Slice 3 plan D27): the participant's private email or mobile, then the six-digit
 * code sent there. The request is answered alike whether or not the address has an account, and
 * the page says so. The email's link carries the code in the fragment: it is moved into the code
 * field, removed from the address bar and posted only when the participant clicks "Log in". The
 * address and code live only in this component's state.
 */
function Login() {
  const { t, i18n } = useTranslation();
  const { api } = Route.useRouteContext();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<"address" | "code">("address");
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<ErrorKey>();
  const [busy, setBusy] = useState(false);
  const language = messageLanguage(i18n.resolvedLanguage);
  const kind = contactKindOf(address);

  // The fragment is read while rendering, also when the link opens in a tab already on this page
  // (only the fragment changes), and then removed from the address bar.
  const [taken, setTaken] = useState("");
  if (location.hash && location.hash !== taken) {
    setTaken(location.hash);
    setCode(location.hash);
    setStep("code");
  }
  useEffect(() => {
    if (location.hash) void navigate({ to: "/login", hash: "", replace: true });
  }, [location.hash, navigate]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (failure) {
      const reason = problemCode(failure);
      setError(isErrorKey(reason) ? reason : "failed");
    } finally {
      setBusy(false);
    }
  }

  const requestCode = () =>
    run(async () => {
      await api.POST("/api/v1/portal/login/code-request", {
        body: { kind, address, language },
      });
      setCode("");
      setStep("code");
    });

  const logIn = () =>
    run(async () => {
      const { data } = await api.POST("/api/v1/portal/login", {
        body: { kind, address, oneTimeCode: code.trim() },
      });
      if (!data) throw new Error("No portal data");
      setCode("");
      queryClient.setQueryData(["portal-me"], data);
      await navigate({ to: "/" });
    });

  return (
    <Stack gap={6}>
      <h1>{t("login.title")}</h1>
      {error && (
        <InlineNotification
          kind="error"
          title={t(`login.errors.${error}`)}
          hideCloseButton
          lowContrast
        />
      )}
      {step === "address" ? (
        <Form onSubmit={submitWith(requestCode)}>
          <Stack gap={5}>
            <p>{t("login.intro")}</p>
            <AddressInput value={address} onChange={setAddress} />
            <Button type="submit" disabled={busy || address.trim() === ""}>
              {t("login.send")}
            </Button>
          </Stack>
        </Form>
      ) : (
        <Form onSubmit={submitWith(logIn)}>
          <Stack gap={5}>
            <InlineNotification kind="info" title={t("login.sent")} hideCloseButton lowContrast />
            <AddressInput value={address} onChange={setAddress} />
            <TextInput
              id="login-code"
              labelText={t("login.code")}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
            />
            <Button
              type="submit"
              disabled={busy || address.trim() === "" || !/^\d{6}$/.test(code.trim())}
            >
              {t("login.submit")}
            </Button>
            <Button
              kind="ghost"
              disabled={busy || address.trim() === ""}
              onClick={() => void requestCode()}
            >
              {t("login.resend")}
            </Button>
          </Stack>
        </Form>
      )}
      <p>
        {t("login.noAccess")} <Link to="/activate">{t("home.activate")}</Link>
      </p>
    </Stack>
  );
}

function AddressInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  return (
    <TextInput
      id="login-address"
      labelText={t("login.address")}
      helperText={t("login.addressHelp")}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      autoComplete="username"
      spellCheck={false}
    />
  );
}
