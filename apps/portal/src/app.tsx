import "@transfer/ui/styles.scss";
import { QueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { createApiClient } from "@transfer/api-client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createPortalRouter } from "./router";

const router = createPortalRouter({ api: createApiClient(), queryClient: new QueryClient() });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
