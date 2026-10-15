import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createRouter, type RouterHistory } from "@tanstack/react-router";
import type { ApiClient } from "@transfer/api-client";
import { syncDocumentLanguage } from "@transfer/ui";
import { I18nextProvider } from "react-i18next";
import { i18n } from "./i18n";
import { routeTree } from "./routeTree.gen";

export interface RouterContext {
  api: ApiClient;
  queryClient: QueryClient;
}

export function createPortalRouter(context: RouterContext, history?: RouterHistory) {
  // <html lang> and <html dir> follow the language (AC-18).
  syncDocumentLanguage(i18n);
  return createRouter({
    routeTree,
    context,
    history,
    basepath: "/portal",
    defaultPreload: "intent",
    Wrap: ({ children }) => (
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={context.queryClient}>{children}</QueryClientProvider>
      </I18nextProvider>
    ),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createPortalRouter>;
  }
}
