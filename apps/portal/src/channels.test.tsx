import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "./i18n";
import { json, me, problem, renderPortal } from "./test-utils";

// PR 3f: channel management (Q123) over a fake API.
afterEach(async () => {
  await i18n.changeLanguage("de");
});

const sms = {
  id: "00000000-0000-4000-8000-000000000002",
  kind: "sms",
  maskedAddress: "+49 … 678",
  consentUpgrade: false,
  verifiedAt: "2026-10-21T11:00:00.000Z",
};
const emailId = me.channels[0]!.id;

describe("channels (Q123)", () => {
  it("adds a channel with its consent and the code sent to it", async () => {
    const user = userEvent.setup();
    const { calls } = renderPortal("/portal/channels", {
      "GET /api/v1/portal/channels": () => json({ channels: me.channels }),
      "POST /api/v1/portal/channels": () => new Response(null, { status: 202 }),
      "POST /api/v1/portal/channels/verification": () =>
        json({ channels: [...me.channels, sms] }, 201),
    });
    expect(await screen.findByText(/E-Mail e…@example.org/)).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "SMS an eine Mobilnummer" }));
    await user.type(screen.getByLabelText("Private Mobilnummer"), "0151 2345678");
    const send = screen.getByRole("button", { name: "Bestätigungscode senden" });
    expect(send).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "Ich willige ein." }));
    await user.click(send);
    await user.type(await screen.findByLabelText("Bestätigungscode"), "123456");
    await user.click(screen.getByRole("button", { name: "Kontaktweg hinzufügen" }));
    expect(await screen.findByText(/Mobilnummer \+49 … 678/)).toBeInTheDocument();
    expect(calls.filter((call) => call.path.startsWith("/api/v1/portal/channels"))).toEqual([
      { path: "/api/v1/portal/channels" },
      {
        path: "/api/v1/portal/channels",
        body: { kind: "sms", address: "0151 2345678", language: "de" },
      },
      {
        path: "/api/v1/portal/channels/verification",
        body: {
          oneTimeCode: "123456",
          consent: true,
          consentVersion: "portal-contact-consent:v2",
          language: "de",
        },
      },
    ]);
  });

  it("removes one of two channels after a confirmation", async () => {
    const user = userEvent.setup();
    let removed = "";
    renderPortal("/portal/channels", {
      "GET /api/v1/portal/channels": () => json({ channels: [...me.channels, sms] }),
      [`DELETE /api/v1/portal/channels/${emailId}`]: () => {
        removed = emailId;
        return json({ sessionEnded: false });
      },
    });
    const item = (await screen.findByText(/E-Mail e…@example.org/)).closest("li")!;
    await user.click(within(item).getByRole("button", { name: "Entfernen" }));
    expect(within(item).getByText(/Ihre Einwilligung für diesen Kontaktweg endet/)).toBeVisible();
    await user.click(within(item).getByRole("button", { name: "Kontaktweg entfernen" }));
    await waitFor(() => expect(screen.queryByText(/E-Mail e…@example.org/)).toBeNull());
    expect(removed).toBe(emailId);
    expect(screen.getByText(/Mobilnummer \+49 … 678/)).toBeInTheDocument();
  });

  it("warns before the last channel goes and says the participant is logged out", async () => {
    const user = userEvent.setup();
    renderPortal("/portal/channels", {
      "GET /api/v1/portal/channels": () => json({ channels: me.channels }),
      [`DELETE /api/v1/portal/channels/${emailId}`]: () => json({ sessionEnded: true }),
    });
    await user.click(await screen.findByRole("button", { name: "Entfernen" }));
    expect(screen.getByText(/Das ist Ihr letzter Kontaktweg/)).toBeInTheDocument();
    // Login ends with it; help in person, by phone or by letter remains (data-protection.md).
    expect(screen.getByText(/persönlich, telefonisch oder per Brief/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByText(/Das ist Ihr letzter Kontaktweg/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Entfernen" }));
    await user.click(screen.getByRole("button", { name: "Kontaktweg entfernen" }));
    expect(await screen.findByText(/Sie sind abgemeldet/)).toBeInTheDocument();
  });

  it("explains a taken address generically", async () => {
    const user = userEvent.setup();
    renderPortal("/portal/channels", {
      "GET /api/v1/portal/channels": () => json({ channels: me.channels }),
      "POST /api/v1/portal/channels": () => problem(422, "channel_in_use"),
    });
    await user.type(await screen.findByLabelText("Private E-Mail-Adresse"), "other@example.org");
    await user.click(screen.getByRole("checkbox", { name: "Ich willige ein." }));
    await user.click(screen.getByRole("button", { name: "Bestätigungscode senden" }));
    expect(await screen.findByText(/Dieser Kontaktweg kann nicht verwendet werden/)).toBeVisible();
    expect(screen.queryByLabelText("Bestätigungscode")).toBeNull();
  });

  it("sends an expired session to the login", async () => {
    renderPortal("/portal/channels", {
      "GET /api/v1/portal/channels": () => problem(401, "unauthenticated"),
    });
    expect(await screen.findByText(/Ihre Sitzung ist abgelaufen/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Anmelden" })).toHaveAttribute("href", "/portal/login");
  });
});

describe("the portal home with login (ADR-0007, Q123)", () => {
  it("offers the login and the activation without a session, and the channels with one", async () => {
    renderPortal("/portal/", { "GET /api/v1/portal/me": () => problem(401, "unauthenticated") });
    expect(await screen.findByRole("link", { name: "Anmelden" })).toHaveAttribute(
      "href",
      "/portal/login",
    );
  });

  it("links an active participant to their channels", async () => {
    renderPortal("/portal/", { "GET /api/v1/portal/me": () => json(me) });
    expect(await screen.findByRole("link", { name: "Kontaktwege verwalten" })).toHaveAttribute(
      "href",
      "/portal/channels",
    );
  });
});

describe("the consent v2 offer (data-protection.md, consent v2)", () => {
  const v1 = { ...me.channels[0]!, consentUpgrade: true };

  it("upgrades the channel with 'Zustimmen'", async () => {
    const user = userEvent.setup();
    const { calls } = renderPortal("/portal/channels", {
      "GET /api/v1/portal/channels": () => json({ channels: [v1, sms] }),
      [`POST /api/v1/portal/channels/${emailId}/consent-upgrade`]: () =>
        json({ result: "upgraded" }),
    });
    const offer = await screen.findByRole("region", {
      name: "Neue Einwilligung für diesen Kontaktweg",
    });
    expect(
      within(offer).getByText(/Erinnerung, dass dort noch etwas offen ist/),
    ).toBeInTheDocument();
    // Only the v1 channel is offered the upgrade.
    expect(screen.getAllByRole("region", { name: /Neue Einwilligung/ })).toHaveLength(1);
    await user.click(within(offer).getByRole("button", { name: "Zustimmen" }));
    expect(
      await screen.findByText("Danke, Ihre Einwilligung ist gespeichert."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Neue Einwilligung/ })).toBeNull();
    expect(calls.at(-1)).toEqual({
      path: `/api/v1/portal/channels/${emailId}/consent-upgrade`,
      body: { consent: true, consentVersion: "portal-contact-consent:v2", language: "de" },
    });
  });

  it("leaves channel, session and login as they are with 'Später', in English too", async () => {
    await i18n.changeLanguage("en");
    const user = userEvent.setup();
    const { calls } = renderPortal("/portal/channels", {
      "GET /api/v1/portal/channels": () => json({ channels: [v1] }),
    });
    const offer = await screen.findByRole("region", { name: "New consent for this contact" });
    expect(within(offer).getByText(/never used for advertising/)).toBeInTheDocument();
    await user.click(within(offer).getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("region", { name: "New consent for this contact" })).toBeNull();
    expect(screen.getByText(/e…@example.org/)).toBeInTheDocument();
    expect(calls.map((call) => call.path)).toEqual(["/api/v1/portal/channels"]);
  });
});
