import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { selfServiceValueSchemas, sensitiveFields } from "@transfer/domain";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "./i18n";
import { json, me, problem, renderPortal } from "./test-utils";

// "Meine Angaben" and "Einwilligungen" over a fake API (data-protection.md, self-service). The
// wizard's own behaviour is tested in @transfer/self-service-ui; this covers the portal's routes,
// requests and links. Synthetic data only.
afterEach(async () => {
  await i18n.changeLanguage("de");
});

const values = Object.fromEntries(Object.keys(selfServiceValueSchemas).map((key) => [key, null]));
const field = (key: string, required = false) => ({ key, required });
const state = (acknowledged: boolean, revision = 0, steppedUp = false) => ({
  revision,
  notice: { version: "self-service-purposes:v1", acknowledged },
  identity: { firstName: "Erika", lastName: "Beispiel", birthDate: "1970-01-01" },
  values,
  customValues: {},
  sensitive: Object.fromEntries(sensitiveFields.map((key) => [key, false])),
  stepUp: { method: "birth_date", done: steppedUp },
  pages: [
    {
      page: "personal",
      sensitive: false,
      complete: revision > 0,
      fields: [field("gender", true), field("maritalStatus")],
    },
    {
      page: "contact",
      sensitive: false,
      complete: true,
      fields: ["address", "phone", "mobile", "privateEmail"].map((key) => field(key)),
    },
  ],
  missing:
    revision > 0
      ? []
      : [
          {
            step: "profiling",
            ruleId: "base-tl407-gender",
            kind: "field",
            key: "gender",
            reason: "missing",
          },
        ],
});

describe("Meine Angaben", () => {
  it("acknowledges the notice, saves a page with its revision and keeps the step in the URL", async () => {
    const user = userEvent.setup();
    let acknowledged = false;
    let saved = false;
    const { calls, router } = renderPortal("/portal/self-service", {
      "GET /api/v1/portal/self-service": () => json(state(acknowledged, saved ? 1 : 0)),
      "POST /api/v1/portal/self-service/notice": () => {
        acknowledged = true;
        return new Response(null, { status: 204 });
      },
      "PUT /api/v1/portal/self-service/pages/personal": () => {
        saved = true;
        return json({ ...state(true, 1), warnings: [] });
      },
    });
    await screen.findByRole("heading", { name: "Wofür wir Ihre Angaben verwenden" });
    await user.click(screen.getByRole("button", { name: "Gelesen, weiter" }));
    await screen.findByRole("heading", { name: "Persönliches" });
    await user.click(screen.getByRole("radio", { name: "Divers" }));
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    await screen.findByRole("heading", { level: 1, name: "Kontakt" });
    expect(router.state.location.search).toEqual({ step: "contact" });
    expect(screen.getByText("2 von 2 Seiten vollständig")).toBeInTheDocument();
    expect(calls.filter((call) => call.body)).toEqual([
      {
        path: "/api/v1/portal/self-service/notice",
        body: { version: "self-service-purposes:v1", language: "de" },
      },
      {
        path: "/api/v1/portal/self-service/pages/personal",
        body: { revision: 0, values: { gender: "diverse", maritalStatus: null } },
      },
    ]);
  });

  it("opens the step in the URL and acknowledges in English when English is shown", async () => {
    const user = userEvent.setup();
    await i18n.changeLanguage("en");
    const { calls } = renderPortal("/portal/self-service?step=contact", {
      "GET /api/v1/portal/self-service": () => json(state(false)),
      "POST /api/v1/portal/self-service/notice": () => new Response(null, { status: 204 }),
    });
    await screen.findByRole("heading", { name: "What we use your details for" });
    await user.click(screen.getByRole("button", { name: "Read, continue" }));
    await waitFor(() =>
      expect(calls.at(-2)).toEqual({
        path: "/api/v1/portal/self-service/notice",
        body: { version: "self-service-purposes:v1", language: "en" },
      }),
    );
  });

  it("steps up with the birth date, then reads and writes the health group on its own routes", async () => {
    const user = userEvent.setup();
    let steppedUp = false;
    const health = {
      page: "health",
      sensitive: true,
      complete: false,
      fields: [field("healthRestrictions", true), field("severeDisability", true)],
    };
    const withHealth = () => {
      const base = state(true, 1, steppedUp);
      return { ...base, pages: [...base.pages, health] };
    };
    const { calls } = renderPortal("/portal/self-service?step=health", {
      "GET /api/v1/portal/self-service": () => json(withHealth()),
      "POST /api/v1/portal/step-up/birth-date": () => {
        steppedUp = true;
        return json({ method: "birth_date", done: true });
      },
      "GET /api/v1/portal/self-service/sensitive/health": () =>
        json({ group: "health", values: { healthRestrictions: null, severeDisability: null } }),
      "PUT /api/v1/portal/self-service/sensitive/health": () =>
        json({ ...withHealth(), revision: 2, warnings: [] }),
    });
    await screen.findByRole("heading", { level: 1, name: "Gesundheit" });
    await user.type(screen.getByLabelText("Ihr Geburtsdatum"), "01.01.1970");
    await user.click(screen.getByRole("button", { name: "Bestätigen" }));
    const restrictions = await screen.findByRole("group", {
      name: "Gesundheitliche Einschränkungen *",
    });
    await user.click(within(restrictions).getByRole("radio", { name: "Nein" }));
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    await screen.findByRole("heading", { level: 1, name: "Übersicht" });
    expect(calls.filter((call) => call.body)).toEqual([
      { path: "/api/v1/portal/step-up/birth-date", body: { birthDate: "1970-01-01" } },
      {
        path: "/api/v1/portal/self-service/sensitive/health",
        body: { revision: 1, values: { healthRestrictions: false, severeDisability: null } },
      },
    ]);
  });

  it("sends an expired session to the login", async () => {
    renderPortal("/portal/self-service", {
      "GET /api/v1/portal/self-service": () => problem(401, "unauthenticated"),
    });
    expect(await screen.findByText(/Ihre Sitzung ist abgelaufen/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Anmelden" })).toHaveAttribute("href", "/portal/login");
  });
});

describe("Einwilligungen", () => {
  it("lists the participant's own consents with purpose, version, given and ended", async () => {
    renderPortal("/portal/consents", {
      "GET /api/v1/portal/consents": () =>
        json({
          consents: [
            {
              id: "00000000-0000-4000-8000-000000000011",
              purpose: "portal_contact",
              source: "portal",
              textVersion: "portal-contact-consent:v1",
              language: "de",
              channelId: "00000000-0000-4000-8000-000000000001",
              givenAt: "2026-10-21T10:00:00.000Z",
              endedAt: null,
              endReason: null,
            },
            {
              id: "00000000-0000-4000-8000-000000000012",
              purpose: "portal_contact",
              source: "portal",
              textVersion: "portal-contact-consent:v1",
              language: "de",
              channelId: "00000000-0000-4000-8000-000000000002",
              givenAt: "2026-10-20T10:00:00.000Z",
              endedAt: "2026-10-21T09:00:00.000Z",
              endReason: "revoked",
            },
          ],
        }),
    });
    await screen.findByRole("heading", { name: "Ihre Einwilligungen" });
    expect(
      screen.getAllByRole("heading", { name: "Kontakt über das Teilnehmerportal" }),
    ).toHaveLength(2);
    expect(screen.getByText("Erteilt am 21.10.2026, 12:00 (im Portal)")).toBeInTheDocument();
    expect(screen.getByText("Gilt")).toBeInTheDocument();
    expect(screen.getByText("Beendet am 21.10.2026, 11:00 (widerrufen)")).toBeInTheDocument();
    expect(screen.getAllByText("Fassung des Textes: portal-contact-consent:v1")).toHaveLength(2);
    expect(screen.getByText(/indem Sie den Kontaktweg entfernen/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Kontaktwege verwalten" })).toHaveAttribute(
      "href",
      "/portal/channels",
    );
  });

  it("says when there is none, and when the session ended", async () => {
    renderPortal("/portal/consents", {
      "GET /api/v1/portal/consents": () => json({ consents: [] }),
    });
    expect(await screen.findByText("Sie haben keine Einwilligungen erteilt.")).toBeInTheDocument();
  });

  it("sends an expired session to the login", async () => {
    renderPortal("/portal/consents", {
      "GET /api/v1/portal/consents": () => problem(401, "unauthenticated"),
    });
    expect(await screen.findByText(/Ihre Sitzung ist abgelaufen/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Anmelden" })).toBeInTheDocument();
  });

  it("explains a failure", async () => {
    renderPortal("/portal/consents", {
      "GET /api/v1/portal/consents": () => problem(500, "internal"),
    });
    expect(await screen.findByText(/konnten nicht geladen werden/)).toBeInTheDocument();
  });
});

describe("the portal home", () => {
  it("links Meine Angaben and Einwilligungen", async () => {
    renderPortal("/portal/", { "GET /api/v1/portal/me": () => json(me) });
    expect(await screen.findByRole("link", { name: "Meine Angaben" })).toHaveAttribute(
      "href",
      "/portal/self-service",
    );
    expect(screen.getByRole("link", { name: "Einwilligungen" })).toHaveAttribute(
      "href",
      "/portal/consents",
    );
  });
});
