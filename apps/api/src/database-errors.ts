/**
 * The stable code of a database function's refusal (SQLSTATE `P0001`; the code is the whole
 * message, never a value), or undefined for any other error. Drizzle wraps the driver's error in
 * `cause`.
 */
export function functionRefusal(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  const { code, message } = (cause ?? {}) as { code?: unknown; message?: unknown };
  return code === "P0001" && typeof message === "string" && message ? message : undefined;
}
