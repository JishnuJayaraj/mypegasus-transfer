import { ZodError } from "zod";
import { StatusServiceError } from "../participations/status-service";

/** A job refusal or failure with a stable code; the message is the code, never a value. */
export class JobError extends Error {
  override readonly name = "JobError";

  constructor(readonly code: string) {
    super(code);
  }
}

/** The stable code of any error a job meets; unknown errors are `unexpected` (CLAUDE.md rule 9). */
export function jobErrorCode(error: unknown): string {
  if (error instanceof JobError || error instanceof StatusServiceError) return error.code;
  if (error instanceof ZodError) return "invalid_payload";
  return "unexpected";
}
