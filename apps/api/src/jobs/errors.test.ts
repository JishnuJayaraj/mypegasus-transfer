import { describe, expect, it } from "vitest";
import { z } from "zod";
import { StatusServiceError } from "../participations/status-service";
import { JobError, jobErrorCode } from "./errors";

describe("jobErrorCode", () => {
  it("keeps stable codes and hides everything else (CLAUDE.md rule 9)", () => {
    expect(jobErrorCode(new JobError("run_not_due"))).toBe("run_not_due");
    expect(jobErrorCode(new StatusServiceError("stale", "stale_status"))).toBe("stale_status");
    expect(jobErrorCode(z.uuid().safeParse("participant 4711").error)).toBe("invalid_payload");
    expect(jobErrorCode(new Error("participant 4711 not found"))).toBe("unexpected");
    expect(jobErrorCode("thrown text")).toBe("unexpected");
  });

  it("gives a JobError its code as the whole message", () => {
    expect(new JobError("changes_refused")).toMatchObject({
      name: "JobError",
      message: "changes_refused",
    });
  });
});
