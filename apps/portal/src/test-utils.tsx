import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { createApiClient } from "@transfer/api-client";
import { createPortalRouter } from "./router";

// The portal over a fake API, for the component tests (synthetic data only).

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": status >= 400 ? "application/problem+json" : "application/json" },
  });
export const problem = (status: number, code: string) =>
  json(
    { type: "urn:transfer:problem:x", title: "x", status, errors: [{ code, detail: "x" }] },
    status,
  );

export const me = {
  firstName: "Erika",
  language: "de",
  sessionExpiresAt: "2026-10-21T12:00:00.000Z",
  channels: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      kind: "email",
      maskedAddress: "e…@example.org",
      verifiedAt: "2026-10-21T10:00:00.000Z",
    },
  ],
};

export type Handler = (body: Record<string, unknown> | undefined) => Response;

export function renderPortal(path: string, routes: Record<string, Handler>) {
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  const api = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      const text = request.method === "GET" ? "" : await request.text();
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
      calls.push({ path: pathname, ...(body && { body }) });
      const handler = routes[`${request.method} ${pathname}`];
      return handler ? handler(body) : json({ status: "ok", version: "1" });
    },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createPortalRouter({ api, queryClient }, history);
  render(<RouterProvider router={router} />);
  return { calls, router };
}
