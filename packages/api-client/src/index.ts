import createClient, { type Middleware } from "openapi-fetch";
import type { components, paths } from "./schema";

export type { components, paths };
export type ProblemDetails = components["schemas"]["ProblemDetails"];

/** An RFC 9457 problem returned by the API (ADR-0010). */
export class ApiProblemError extends Error {
  override readonly name = "ApiProblemError";

  constructor(readonly problem: ProblemDetails) {
    super(problem.title);
  }

  get status(): number {
    return this.problem.status;
  }
}

const throwProblems: Middleware = {
  async onResponse({ response }) {
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok && contentType.startsWith("application/problem+json")) {
      throw new ApiProblemError((await response.json()) as ProblemDetails);
    }
    return undefined;
  },
};

/**
 * The typed API client for both SPAs. Problem responses reject with `ApiProblemError`, so
 * callers (e.g. TanStack Query) get typed errors.
 */
export function createApiClient(options: { baseUrl?: string; fetch?: typeof fetch } = {}) {
  const client = createClient<paths>({
    baseUrl: options.baseUrl ?? "",
    credentials: "same-origin",
    ...(options.fetch && { fetch: options.fetch }),
  });
  client.use(throwProblems);
  return client;
}

export type ApiClient = ReturnType<typeof createApiClient>;
