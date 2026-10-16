import type { Decision } from "../decide";

/** A decision as one comparable string (tests only). */
export function cell(d: Decision): string {
  if (d.effect === "deny") {
    return ["deny", d.because, "question" in d && d.question].filter(Boolean).join(" ");
  }
  return ["allow", d.view, d.audit, d.flagForReview && "review", d.grant && "grant"]
    .filter(Boolean)
    .join(" ");
}
