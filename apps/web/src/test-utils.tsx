import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { createApiClient } from "@transfer/api-client";
import { createQueryClient } from "./api";
import { createAppRouter } from "./router";

type Handler = (request: { query: URLSearchParams; body: unknown }) => Response | Promise<Response>;

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
      const handler = routes[key] ?? defaultRoutes(key);
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
  return { router, queryClient };
}

/**
 * Synthetic staff users: the dev switcher's entries (`role`) and, as `GET /me`, the session user
 * (`mayCreateProjects`, `orgRoles`).
 */
export const staffUsers = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    displayName: "Erika Musterfrau",
    role: "admin",
    mayCreateProjects: false,
    orgRoles: [{ role: "admin", regionId: null }],
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    displayName: "Petra Projektleitung",
    role: "project_lead",
    mayCreateProjects: true,
    orgRoles: [],
  },
];

export const consultant = {
  id: "00000000-0000-4000-8000-000000000004",
  displayName: "Bernd Beratung",
};

export const regions = [
  {
    id: "00000000-0000-4000-b000-000000000101",
    code: "NORD",
    name: "Niederlassung Nord",
    createdAt: "2026-10-15T08:00:00.000000Z",
  },
  {
    id: "00000000-0000-4000-b000-000000000102",
    code: "SUED",
    name: "Niederlassung Süd",
    createdAt: "2026-10-15T08:00:00.000000Z",
  },
];

/** The seeded team of a project as its PL sees it (Q126). */
export const team = {
  members: [
    {
      staffUserId: consultant.id,
      displayName: consultant.displayName,
      roles: ["consultant"],
      deactivated: false,
    },
    {
      staffUserId: staffUsers[1]!.id,
      displayName: staffUsers[1]!.displayName,
      roles: ["project_lead"],
      deactivated: false,
    },
  ],
  capabilities: { manageMembers: true, addReplacementLead: true, assignParticipations: true },
};

/** Routes most pages read, unless a test answers them itself. */
function defaultRoutes(key: string): Handler | undefined {
  if (key === "GET /api/v1/regions") return () => json(regions);
  if (/^GET \/api\/v1\/projects\/[^/]+\/members$/.test(key)) return () => json(team);
  return undefined;
}

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
  regionId: regions[0]!.id,
  tKugNumber: null,
  employerBetriebsnummer: null,
  employerEconomicClass: null,
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
    importParticipations: true,
    setProjectRegion: true,
    editKug200aHeader: true,
  },
};

/** A synthetic work list row (`WorklistItem`): nothing open, no deadline, no capability. */
export const worklistItem = (
  overrides: Record<string, unknown> & { capabilities?: object } = {},
) => ({
  id: "00000000-0000-4000-a000-000000000001",
  status: "imported",
  profilingStatus: "not_started",
  dsvStatus: "not_offered",
  entryWaveId: null,
  placementAgenturKey: null,
  personnelNumber: "BSP-0001",
  lastName: "Beispiel",
  firstName: "Erika",
  consultants: [],
  activationStatus: { account: "not_activated", code: "none", issuedAt: null, expiresAt: null },
  privacyNoticeState: {
    state: "provided",
    dueOn: "2026-11-15",
    providedAt: "2026-10-16T08:00:00.000Z",
  },
  actions: [],
  deadlines: [],
  caseItems: [],
  flags: [],
  portal: "not_reachable",
  reminder: null,
  appointments: { next: null, items: [] },
  ...overrides,
  capabilities: {
    assignEntryWave: false,
    issueActivationCode: false,
    recordHandover: false,
    revokeActivationCode: false,
    providePrivacyNotice: false,
    remind: { allowed: false, code: null, channel: null },
    invite: { allowed: false, channel: null },
    ...overrides.capabilities,
  },
});

/** The work list's answer at 10:42 Berlin time. */
export const worklist = (items: object[]) => ({ generatedAt: "2026-10-22T08:42:00.000Z", items });
