import { ApiProblemError } from "@transfer/api-client";

/**
 * The code of a refused request: `session_expired` for a 401, else the first problem code. The
 * pages map it to a message of their own and never show it raw.
 */
export function problemCode(failure: unknown): string | undefined {
  if (!(failure instanceof ApiProblemError)) return undefined;
  return failure.status === 401 ? "session_expired" : failure.problem.errors?.[0]?.code;
}

/** The language of the portal's messages: the page's, German by default. */
export const messageLanguage = (resolved: string | undefined) => (resolved === "en" ? "en" : "de");
