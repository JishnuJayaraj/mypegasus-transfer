import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { ApiProblemError, type ApiClient } from "@transfer/api-client";

/** The logged-in participant, or null without a live session (an idle or expired one too). */
export const meQuery = (api: ApiClient) => ({
  queryKey: ["portal-me"],
  queryFn: async () => {
    try {
      const { data } = await api.GET("/api/v1/portal/me");
      if (!data) throw new Error("No portal data");
      return data;
    } catch (error) {
      if (error instanceof ApiProblemError && error.status === 401) return null;
      throw error;
    }
  },
});

/** Nothing of the participant stays in the cache: every query goes, the session is null. */
export function forgetParticipant(queryClient: QueryClient) {
  queryClient.clear();
  queryClient.setQueryData(["portal-me"], null);
}

/** "Abmelden": ends the session, forgets what was loaded and shows the start page. */
export function useLogout() {
  const { api } = useRouteContext({ from: "__root__" });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    await api.POST("/api/v1/portal/logout", { body: {} });
    forgetParticipant(queryClient);
    await navigate({ to: "/" });
  };
}
