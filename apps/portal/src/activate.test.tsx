import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "./i18n";
import { json, me, problem, renderPortal } from "./test-utils";

// Slice 3 plan, PR 3e: the portal's activation flow (D22, D23) over a fake API.
const state = (nextStep: string, extra: object = {}) => ({
  nextStep,
  purpose: "activation",
  channel: "letter",
  deliveryKind: null,
  language: "de",
  noticeVersion: "art14-activation:v1",
  consentVersion: "portal-contact-consent:v1",
  ...extra,
});
afterEach(async () => {
  await i18n.changeLanguage("de");
});

const consentBox = () => screen.getByRole("checkbox", { name: "Ich willige ein." });

describe("activation (D22, D23)", () => {
  it("takes the code from the fragment, removes it from the address and posts it only on a click", async () => {
    const { calls, router } = renderPortal("/portal/activate#ABCD2345EFGH", {});
    expect(await screen.findByLabelText("Aktivierungscode")).toHaveValue("ABCD2345EFGH");
    await waitFor(() => expect(router.state.location.hash).toBe(""));
    expect(router.state.location.href).not.toContain("ABCD");
    expect(calls.filter((c) => c.path.startsWith("/api/v1/portal"))).toEqual([]);
  });

  it("walks a letter through the notice, birth date, channel with consent and one-time code", async () => {
    const user = userEvent.setup();
    const { calls } = renderPortal("/portal/activate#ABCD2345EFGH", {
      "POST /api/v1/portal/activation": () => json(state("birth_date")),
      "POST /api/v1/portal/activation/birth-date": () => json(state("channel")),
      "POST /api/v1/portal/activation/channel": () => json(state("one_time_code"), 202),
      "POST /api/v1/portal/activation/completion": () => json(me, 201),
    });
    await user.click(await screen.findByRole("button", { name: "Code prüfen" }));
    expect(
      await screen.findByRole("heading", { name: "Datenschutzhinweise nach Art. 14 DSGVO" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Gelesen, weiter" }));

    await user.type(await screen.findByLabelText("Geburtsdatum"), "31.02.1970");
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    expect(await screen.findByText(/gültiges Datum im Format TT.MM.JJJJ/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Geburtsdatum"));
    await user.type(screen.getByLabelText("Geburtsdatum"), "1.1.1970");
    await user.click(screen.getByRole("button", { name: "Weiter" }));

    await user.type(await screen.findByLabelText("Private E-Mail-Adresse"), "erika@example.org");
    const send = screen.getByRole("button", { name: "Bestätigungscode senden" });
    expect(send).toBeDisabled();
    expect(
      screen.getByRole("heading", {
        name: "Einwilligung in den Kontakt über das Teilnehmerportal",
      }),
    ).toBeInTheDocument();
    await user.click(consentBox());
    await user.click(send);

    await user.type(await screen.findByLabelText("Bestätigungscode"), "123456");
    await user.click(screen.getByRole("button", { name: "Zugang aktivieren" }));
    expect(
      await screen.findByRole("heading", { name: "Ihr Zugang ist aktiv" }),
    ).toBeInTheDocument();

    expect(calls.filter((c) => c.path.startsWith("/api/v1/portal"))).toEqual([
      { path: "/api/v1/portal/activation", body: { code: "ABCD2345EFGH" } },
      { path: "/api/v1/portal/activation/birth-date", body: { birthDate: "1970-01-01" } },
      {
        path: "/api/v1/portal/activation/channel",
        body: { kind: "email", address: "erika@example.org", language: "de" },
      },
      {
        path: "/api/v1/portal/activation/completion",
        body: {
          oneTimeCode: "123456",
          noticeVersion: "art14-activation:v1",
          consent: true,
          consentVersion: "portal-contact-consent:v1",
          language: "de",
        },
      },
    ]);
  });

  it("retypes an in-person code's address with consent, then completes with it", async () => {
    const user = userEvent.setup();
    const inPerson = { channel: "in_person", deliveryKind: "sms", language: "en" };
    const { calls } = renderPortal("/portal/activate", {
      "POST /api/v1/portal/activation": () => json(state("delivery_address", inPerson)),
      "POST /api/v1/portal/activation/delivery-address": () => json(state("complete", inPerson)),
      "POST /api/v1/portal/activation/completion": () => json({ ...me, language: "en" }, 201),
    });
    await user.type(await screen.findByLabelText("Aktivierungscode"), "abcd-2345-efgh");
    await user.click(screen.getByRole("button", { name: "Code prüfen" }));
    // The PL issued in English: the portal continues in English.
    await user.click(await screen.findByRole("button", { name: "I have read this, continue" }));
    await user.type(await screen.findByLabelText("Private mobile number"), "0151 2345678");
    await user.click(screen.getByRole("checkbox", { name: "I consent." }));
    await user.click(screen.getByRole("button", { name: "Activate access" }));
    expect(
      await screen.findByRole("heading", { name: "Your access is active" }),
    ).toBeInTheDocument();
    expect(calls.map((c) => c.path).filter((p) => p.startsWith("/api/v1/portal"))).toEqual([
      "/api/v1/portal/activation",
      "/api/v1/portal/activation/delivery-address",
      "/api/v1/portal/activation/completion",
    ]);
    expect(calls.at(-1)!.body).toMatchObject({ deliveryAddress: "0151 2345678", language: "en" });
    expect(document.documentElement.lang).toBe("en");
  });

  it("says a recovery restored the access (D24)", async () => {
    const user = userEvent.setup();
    const recovery = { purpose: "recovery", channel: "sheet" };
    renderPortal("/portal/activate#ABCD2345EFGH", {
      "POST /api/v1/portal/activation": () => json(state("channel", recovery)),
      "POST /api/v1/portal/activation/channel": () => json(state("one_time_code", recovery), 202),
      "POST /api/v1/portal/activation/completion": () => json(me, 201),
    });
    await user.click(await screen.findByRole("button", { name: "Code prüfen" }));
    await user.click(await screen.findByRole("button", { name: "Gelesen, weiter" }));
    await user.type(await screen.findByLabelText("Private E-Mail-Adresse"), "neu@example.org");
    await user.click(consentBox());
    await user.click(screen.getByRole("button", { name: "Bestätigungscode senden" }));
    await user.type(await screen.findByLabelText("Bestätigungscode"), "123456");
    await user.click(screen.getByRole("button", { name: "Zugang aktivieren" }));
    expect(
      await screen.findByRole("heading", { name: "Ihr Zugang ist wiederhergestellt" }),
    ).toBeInTheDocument();
  });

  it.each([
    ["code_invalid", /Dieser Code ist nicht gültig.*datenschutz@example.invalid/],
    ["rate_limited", /Zu viele Versuche/],
    ["before_cutoff", /nicht mehr möglich/],
  ])("explains %s without showing a raw code", async (code, text) => {
    const user = userEvent.setup();
    renderPortal("/portal/activate", {
      "POST /api/v1/portal/activation": () => problem(code === "rate_limited" ? 429 : 422, code),
    });
    await user.type(await screen.findByLabelText("Aktivierungscode"), "ABCD2345EFGH");
    await user.click(screen.getByRole("button", { name: "Code prüfen" }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByText(code)).not.toBeInTheDocument();
  });

  it("starts over when the session expired", async () => {
    const user = userEvent.setup();
    renderPortal("/portal/activate", {
      "POST /api/v1/portal/activation": () => json(state("birth_date")),
      "POST /api/v1/portal/activation/birth-date": () => problem(401, "unauthenticated"),
    });
    await user.type(await screen.findByLabelText("Aktivierungscode"), "ABCD2345EFGH");
    await user.click(screen.getByRole("button", { name: "Code prüfen" }));
    await user.click(await screen.findByRole("button", { name: "Gelesen, weiter" }));
    await user.type(await screen.findByLabelText("Geburtsdatum"), "01.01.1970");
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    expect(await screen.findByText(/Ihre Sitzung ist abgelaufen/)).toBeInTheDocument();
    expect(screen.getByLabelText("Aktivierungscode")).toHaveValue("");
  });
});

describe("the portal home", () => {
  it("greets an active participant with their masked channels and logs out", async () => {
    const user = userEvent.setup();
    let loggedIn = true;
    const { calls } = renderPortal("/portal/", {
      "GET /api/v1/portal/me": () => (loggedIn ? json(me) : problem(401, "unauthenticated")),
      "POST /api/v1/portal/logout": () => {
        loggedIn = false;
        return new Response(null, { status: 204 });
      },
    });
    expect(await screen.findByRole("heading", { name: "Hallo Erika" })).toBeInTheDocument();
    expect(screen.getByText(/E-Mail e…@example.org, bestätigt am 21.10.2026/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Abmelden" }));
    expect(await screen.findByRole("link", { name: "Zugang aktivieren" })).toBeInTheDocument();
    expect(calls).toContainEqual({ path: "/api/v1/portal/logout", body: {} });
  });

  it("offers the activation without a session", async () => {
    renderPortal("/portal/", { "GET /api/v1/portal/me": () => problem(401, "unauthenticated") });
    expect(await screen.findByRole("link", { name: "Zugang aktivieren" })).toHaveAttribute(
      "href",
      "/portal/activate",
    );
  });
});
