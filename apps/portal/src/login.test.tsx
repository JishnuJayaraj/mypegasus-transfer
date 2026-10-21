import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "./i18n";
import { json, me, problem, renderPortal } from "./test-utils";

// Slice 3 plan, PR 3f: the portal login (D27) over a fake API.
afterEach(async () => {
  await i18n.changeLanguage("de");
});

const portalCalls = (calls: { path: string; body?: Record<string, unknown> }[]) =>
  calls.filter((call) => call.path.startsWith("/api/v1/portal/login"));

describe("login (D27)", () => {
  it("asks for the address, says a code goes out only if it has an account, and logs in", async () => {
    const user = userEvent.setup();
    const { calls, router } = renderPortal("/portal/login", {
      "POST /api/v1/portal/login/code-request": () => new Response(null, { status: 202 }),
      "POST /api/v1/portal/login": () => json(me),
      "GET /api/v1/portal/me": () => json(me),
    });
    await user.type(
      await screen.findByLabelText("E-Mail-Adresse oder Mobilnummer"),
      "erika@example.org",
    );
    await user.click(screen.getByRole("button", { name: "Code senden" }));
    expect(
      await screen.findByText(/Wenn diese Adresse zu einem Zugang gehört/),
    ).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "Anmelden" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("Anmeldecode"), "123456");
    await user.click(submit);
    expect(await screen.findByRole("heading", { name: "Hallo Erika" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    expect(portalCalls(calls)).toEqual([
      {
        path: "/api/v1/portal/login/code-request",
        body: { kind: "email", address: "erika@example.org", language: "de" },
      },
      {
        path: "/api/v1/portal/login",
        body: { kind: "email", address: "erika@example.org", oneTimeCode: "123456" },
      },
    ]);
  });

  it("takes the code from the email link's fragment and logs in only on a click", async () => {
    const user = userEvent.setup();
    const { calls, router } = renderPortal("/portal/login#654321", {
      "POST /api/v1/portal/login": () => json(me),
    });
    expect(await screen.findByLabelText("Anmeldecode")).toHaveValue("654321");
    await waitFor(() => expect(router.state.location.hash).toBe(""));
    expect(router.state.location.href).not.toContain("654321");
    expect(portalCalls(calls)).toEqual([]);
    // A mobile number in the one address field is an SMS channel.
    await user.type(screen.getByLabelText("E-Mail-Adresse oder Mobilnummer"), "0151 2345678");
    await user.click(screen.getByRole("button", { name: "Anmelden" }));
    await waitFor(() =>
      expect(portalCalls(calls)).toEqual([
        {
          path: "/api/v1/portal/login",
          body: { kind: "sms", address: "0151 2345678", oneTimeCode: "654321" },
        },
      ]),
    );
  });

  it.each([
    ["one_time_code_invalid", 422, /Der Code ist falsch oder nicht mehr gültig/],
    ["rate_limited", 429, /Zu viele Versuche/],
  ])("explains %s without showing a raw code", async (code, status, text) => {
    const user = userEvent.setup();
    renderPortal("/portal/login#123456", {
      "POST /api/v1/portal/login": () => problem(status, code),
    });
    await user.type(
      await screen.findByLabelText("E-Mail-Adresse oder Mobilnummer"),
      "erika@example.org",
    );
    await user.click(screen.getByRole("button", { name: "Anmelden" }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByText(code)).not.toBeInTheDocument();
  });

  it("speaks English and sends the code request in the portal's language", async () => {
    const user = userEvent.setup();
    await i18n.changeLanguage("en");
    const { calls } = renderPortal("/portal/login", {
      "POST /api/v1/portal/login/code-request": () => new Response(null, { status: 202 }),
    });
    await user.type(
      await screen.findByLabelText("Email address or mobile number"),
      "+44 7700 900123",
    );
    await user.click(screen.getByRole("button", { name: "Send code" }));
    expect(await screen.findByText(/If this address belongs to an account/)).toBeInTheDocument();
    expect(portalCalls(calls)[0]!.body).toEqual({
      kind: "sms",
      address: "+44 7700 900123",
      language: "en",
    });
  });
});
