import "@transfer/ui/styles.scss";
import { RouterProvider } from "@tanstack/react-router";
import { createApiClient } from "@transfer/api-client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createQueryClient } from "./api";
import { createAppRouter } from "./router";

const router = createAppRouter({ api: createApiClient(), queryClient: createQueryClient() });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
