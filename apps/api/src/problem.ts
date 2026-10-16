import type { Context } from "hono";
import { ProblemDetails as ProblemDetailsSchema, type ProblemDetails } from "@transfer/domain";
import type { ZodError } from "zod";

/** Stable problem types (ADR-0010, Slice 1 plan 5.4, Slice 2 plan 5.12). */
export const problemTypes = {
  "validation-error": [400, "Validation failed"],
  unauthenticated: [401, "Not authenticated"],
  forbidden: [403, "Forbidden"],
  "not-found": [404, "Not found"],
  "unsupported-media-type": [415, "Unsupported media type"],
  /** A domain rule refused the request; `errors[].code` names it, never a value. */
  "domain-error": [422, "Refused by a domain rule"],
  "internal-error": [500, "Internal server error"],
  "service-unavailable": [503, "Service unavailable"],
} as const satisfies Record<string, [number, string]>;

export type ProblemType = keyof typeof problemTypes;
type ProblemError = NonNullable<ProblemDetails["errors"]>[number];

type ProblemStatus<T extends ProblemType> = (typeof problemTypes)[T][0];

export function problem<T extends ProblemType>(
  c: Context,
  type: T,
  extra: Partial<ProblemDetails> = {},
) {
  const [status, title] = problemTypes[type];
  const body: ProblemDetails = { type: `urn:transfer:problem:${type}`, title, status, ...extra };
  return c.json(body, status as ProblemStatus<T>, { "Content-Type": "application/problem+json" });
}

/** A JSON pointer into the body, or the name of a query or path parameter. */
function location(target: string, path: readonly PropertyKey[]) {
  return target === "json"
    ? {
        pointer: `/${path.map((p) => String(p).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`,
      }
    : { parameter: String(path[0]) };
}

/**
 * Maps Zod issues to `errors[]`: a JSON pointer for the body, a parameter name for query and
 * path. Only the issue code and message; never the submitted value.
 */
export function validationProblem(c: Context, error: ZodError, target: string) {
  const errors = error.issues.flatMap((issue): ProblemError[] => {
    // A strict schema's unknown fields: one error per field, at the field's own location.
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        ...location(target, [...issue.path, key]),
        code: issue.code,
        detail: "Unknown field",
      }));
    }
    const code = (issue as { params?: { code?: string } }).params?.code ?? issue.code;
    return [{ ...location(target, issue.path), code, detail: issue.message }];
  });
  return problem(c, "validation-error", { errors });
}

const problemContent = {
  "application/problem+json": { schema: ProblemDetailsSchema },
};

/** OpenAPI response entries for the given problem types. */
export function problemResponses<T extends ProblemType>(...types: T[]) {
  return Object.fromEntries(
    types.map((type) => [
      problemTypes[type][0],
      { description: problemTypes[type][1], content: problemContent },
    ]),
  ) as { [K in T as ProblemStatus<K>]: { description: string; content: typeof problemContent } };
}

/** A domain refusal (422) with its stable codes (Slice 2 plan, R21). */
export function domainProblem(c: Context, codes: readonly string[]) {
  return problem(c, "domain-error", {
    errors: codes.map((code) => ({ pointer: "", code, detail: "Refused by a domain rule" })),
  });
}
