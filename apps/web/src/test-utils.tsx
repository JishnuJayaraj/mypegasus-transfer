import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { createApiClient } from "@transfer/api-client";
import { createQueryClient } from "./api";
import { createAppRouter } from "./router";

type Handler = (request: { query: URLSearchParams; body: unknown }) => Response;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const problem = (status: number, type: string, extra: object = {}) =>
  new Response(
    JSON.stringify({ type: `urn:transfer:problem:${type}`, title: type, status, ...extra }),
    {
      status,
      headers: { "Content-Type": "application/problem+json" },
    },
  );

/**
 * The real API client over a fake fetch. Routes are keyed "METHOD /path"; every call is
 * recorded so tests can check what the UI sent.
 */
export function mockApi(routes: Record<string, Handler>) {
  const calls: { key: string; body: unknown }[] = [];
  const api = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const key = `${request.method} ${url.pathname}`;
      const body =
        request.method === "GET" ? undefined : await request.json().catch(() => undefined);
      calls.push({ key, body });
      const handler = routes[key];
      return handler ? handler({ query: url.searchParams, body }) : problem(404, "not-found");
    },
  });
  return { api, calls };
}

/** Renders the whole app at `path` with a memory history. */
export function renderApp(path: string, api: ReturnType<typeof mockApi>["api"]) {
  const queryClient = createQueryClient();
  const router = createAppRouter(
    { api, queryClient },
    createMemoryHistory({ initialEntries: [path] }),
  );
  render(<RouterProvider router={router} />);
  return { router };
}

export const staffUsers = [
  { id: "00000000-0000-4000-8000-000000000001", displayName: "Erika Musterfrau", role: "admin" },
  {
    id: "00000000-0000-4000-8000-000000000003",
    displayName: "Petra Projektleitung",
    role: "project_lead",
  },
];

export const project = {
  id: "00000000-0000-4000-9000-000000000001",
  name: "Restrukturierung Werk Nord",
  customerName: "Beispiel Maschinenbau GmbH",
  type: "ta_tg",
  status: "draft",
  projectAgenturKey: null,
  activatedAt: null,
  createdAt: "2026-10-15T08:30:00.123456Z",
  createdBy: staffUsers[1]!.id,
};

/** A project's configuration without pins (Slice 2 plan 5.12). */
export const unpinnedConfig = {
  projectAgenturKey: null,
  baseDefaultsVersion: 1,
  pins: [],
  projectBlockers: [{ code: "project_activation_blocked", agenturKey: null }],
  agenturen: [],
  activationBlockers: ["project_activation_blocked"],
  override: { version: 0, agenturSettings: [], relaxations: [] },
  relaxationRequests: [],
  relaxableRules: [],
  capabilities: {
    pinTemplate: true,
    setProjectAgentur: true,
    changeOverride: true,
    requestRelaxation: true,
    activateProject: true,
    migrateTemplate: true,
  },
};
