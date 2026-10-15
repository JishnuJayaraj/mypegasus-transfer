import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createRouter, type RouterHistory } from "@tanstack/react-router";
import type { ApiClient } from "@transfer/api-client";
import { I18nextProvider } from "react-i18next";
import { ApiContext } from "./api";
import { i18n } from "./i18n";
import { routeTree } from "./routeTree.gen";

export interface RouterContext {
  api: ApiClient;
  queryClient: QueryClient;
}

export function createAppRouter(context: RouterContext, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context,
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
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
