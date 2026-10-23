import { infiniteQueryOptions, QueryClient, queryOptions } from "@tanstack/react-query";
import { ApiProblemError, type ApiClient } from "@transfer/api-client";
import { createContext, useContext } from "react";

export const ApiContext = createContext<ApiClient | null>(null);

export function useApi(): ApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi() outside ApiContext");
  return api;
}

/** Problems reject in the client (ApiProblemError); anything else without data is an error too. */
async function unwrap<T>(request: Promise<{ data?: T; response: Response }>): Promise<T> {
  const { data, response } = await request;
  if (data === undefined) throw new Error(`Unexpected API response ${response.status}`);
  return data;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // Retrying a problem (401, 404, 400) never helps; network errors get one retry.
      queries: { retry: (count, error) => !(error instanceof ApiProblemError) && count < 1 },
    },
  });
}

export const meQuery = (api: ApiClient) =>
  queryOptions({ queryKey: ["me"], queryFn: () => unwrap(api.GET("/api/v1/me")) });

export const staffUsersQuery = (api: ApiClient) =>
  queryOptions({
    queryKey: ["dev", "staff-users"],
    queryFn: () => unwrap(api.GET("/api/v1/dev/staff-users")),
    staleTime: Infinity,
  });

export const projectQuery = (api: ApiClient, projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId],
    queryFn: () =>
      unwrap(api.GET("/api/v1/projects/{projectId}", { params: { path: { projectId } } })),
  });

/** All waves of a project (a handful), page by page. */
export const entryWavesQuery = (api: ApiClient, projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "entry-waves"],
    queryFn: async () => {
      const waves = [];
      let cursor: string | undefined;
      do {
        const query = { limit: 100, ...(cursor && { cursor }) };
        const path = "/api/v1/projects/{projectId}/entry-waves";
        const page = await unwrap(api.GET(path, { params: { path: { projectId }, query } }));
        waves.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return waves;
    },
  });

/** The project's pins and blockers (regional-variation.md). */
export const projectConfigQuery = (api: ApiClient, projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "config"],
    queryFn: () =>
      unwrap(api.GET("/api/v1/projects/{projectId}/config", { params: { path: { projectId } } })),
  });

/** The whole template catalog (a handful of versions), page by page; 403 unless a PL (Q108). */
export const templateCatalogQuery = (api: ApiClient) =>
  queryOptions({
    queryKey: ["config", "templates"],
    queryFn: async () => {
      const templates = [];
      let cursor: string | undefined;
      do {
        const query = { limit: 100, ...(cursor && { cursor }) };
        const page = await unwrap(api.GET("/api/v1/config/templates", { params: { query } }));
        templates.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return templates;
    },
    staleTime: Infinity,
  });

export const projectsQuery = (api: ApiClient) =>
  infiniteQueryOptions({
    queryKey: ["projects"],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/api/v1/projects", {
          params: { query: { limit: 50, ...(pageParam && { cursor: pageParam }) } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

/**
 * The work list: the viewer's whole scope of the project in one snapshot, kept in memory only
 * (data-protection.md, the work list and the dashboard). Its key is the prefix of every
 * participant query of the project, so a change to a participation refreshes the list and the
 * dashboard alike. No filter or search term is ever part of a key.
 */
export const worklistQuery = (api: ApiClient, projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "participations"],
    queryFn: () =>
      unwrap(api.GET("/api/v1/projects/{projectId}/worklist", { params: { path: { projectId } } })),
    retry: false,
  });

/** The dashboard's counts of the same scope. */
export const dashboardQuery = (api: ApiClient, projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "participations", "dashboard"],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/projects/{projectId}/dashboard", { params: { path: { projectId } } }),
      ),
    retry: false,
  });

/** One participation with the fields the viewer may read (data-protection.md, "Participation detail"). */
export const participationQuery = (api: ApiClient, participationId: string) =>
  queryOptions({
    queryKey: ["participations", participationId],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/participations/{participationId}", {
          params: { path: { participationId } },
        }),
      ),
  });

/** The "Selbstauskunft" tab: normal mode, values the viewer reads, presence, missing items. */
export const participationSelfServiceQuery = (api: ApiClient, participationId: string) =>
  queryOptions({
    queryKey: ["participations", participationId, "self-service"],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/participations/{participationId}/self-service", {
          params: { path: { participationId } },
        }),
      ),
  });

export const participationDocumentsQuery = (api: ApiClient, participationId: string) =>
  queryOptions({
    queryKey: ["participations", participationId, "documents"],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/participations/{participationId}/documents", {
          params: { path: { participationId } },
        }),
      ),
  });

export const participationActivationQuery = (api: ApiClient, participationId: string) =>
  queryOptions({
    queryKey: ["participations", participationId, "activation"],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/participations/{participationId}/activation", {
          params: { path: { participationId } },
        }),
      ),
  });

/** The tab "Nachrichten": the participation's reminders, newest first (data-protection.md, reminders). */
export const participationRemindersQuery = (api: ApiClient, participationId: string) =>
  infiniteQueryOptions({
    queryKey: ["participations", participationId, "reminders"],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/api/v1/participations/{participationId}/reminders", {
          params: {
            path: { participationId },
            query: { limit: 50, ...(pageParam && { cursor: pageParam }) },
          },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });

/**
 * The tab "Verlauf": the participation's audit history, newest first (data-protection.md, audit
 * metadata). The first page is audited as an opening, so it is fetched only when the tab is shown.
 */
export const participationHistoryQuery = (api: ApiClient, participationId: string) =>
  infiniteQueryOptions({
    queryKey: ["participations", participationId, "history"],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/api/v1/participations/{participationId}/history", {
          params: {
            path: { participationId },
            query: { limit: 50, ...(pageParam && { cursor: pageParam }) },
          },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });

/** The regions (a handful of Niederlassungen), for the region pickers (Q126). */
export const regionsQuery = (api: ApiClient) =>
  queryOptions({
    queryKey: ["regions"],
    queryFn: () => unwrap(api.GET("/api/v1/regions")),
  });

/** The staff accounts with their org roles (the global admin), page by page. */
export const staffAccountsQuery = (api: ApiClient) =>
  infiniteQueryOptions({
    queryKey: ["staff-users"],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET("/api/v1/staff-users", {
          params: { query: { limit: 100, ...(pageParam && { cursor: pageParam }) } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

/** The project's members, their roles and what the viewer may do with the team (Q126). */
export const projectTeamQuery = (api: ApiClient, projectId: string) =>
  queryOptions({
    queryKey: ["projects", projectId, "members"],
    queryFn: () =>
      unwrap(api.GET("/api/v1/projects/{projectId}/members", { params: { path: { projectId } } })),
  });

/** Active staff whose name contains `search` (id and name), for the member picker. */
export const staffDirectoryQuery = (api: ApiClient, search: string) =>
  queryOptions({
    queryKey: ["staff-directory", search],
    queryFn: () => unwrap(api.GET("/api/v1/staff-directory", { params: { query: { search } } })),
    enabled: search.trim().length > 0,
  });
