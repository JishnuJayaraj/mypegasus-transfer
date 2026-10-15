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
