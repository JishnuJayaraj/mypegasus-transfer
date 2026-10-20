import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createRouter, type RouterHistory } from "@tanstack/react-router";
import type { ApiClient } from "@transfer/api-client";
import { I18nextProvider } from "react-i18next";
import { ApiContext } from "./api";
import { i18n } from "./i18n";
import { routeTree } from "./routeTree.gen";
import { watchSession, type SessionTracker } from "./session";

export interface RouterContext {
  api: ApiClient;
  queryClient: QueryClient;
  session: SessionTracker;
}

export function createAppRouter(context: Omit<RouterContext, "session">, history?: RouterHistory) {
  // A 401 anywhere returns to the login page, with "Sitzung abgelaufen" after a session.
  const session = watchSession(context.api, (expired) => {
    const { pathname } = router.state.location;
    if (pathname === "/login") return;
    context.queryClient.removeQueries({ queryKey: ["me"] });
    void router.navigate({
      to: "/login",
      search: { returnTo: pathname, ...(expired && { reason: "expired" as const }) },
    });
  });
  const router = createRouter({
    routeTree,
    context: { ...context, session },
    history,
    defaultPreload: "intent",
    // Data freshness is TanStack Query's job; the router always asks it.
    defaultPreloadStaleTime: 0,
    Wrap: ({ children }) => (
      <I18nextProvider i18n={i18n}>
        <ApiContext value={context.api}>
          <QueryClientProvider client={context.queryClient}>{children}</QueryClientProvider>
        </ApiContext>
      </I18nextProvider>
    ),
  });
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
