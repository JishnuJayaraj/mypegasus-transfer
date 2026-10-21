import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { createDetached } from "./detached";

describe("detached work", () => {
  it("settles once the tasks finished and logs a failure without its message", async () => {
    const logs: string[] = [];
    const detached = createDetached(
      pino({ level: "info" }, { write: (line: string) => logs.push(line) }),
    );
    let finished = false;
    detached.run("send", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished = true;
    });
    detached.run("fail", async () => {
      throw new Error("to person@example.invalid");
    });
    await detached.settle();
    expect(finished).toBe(true);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!)).toMatchObject({ task: "fail", msg: "detached task failed" });
    expect(logs[0]).not.toContain("person@example.invalid");
    await detached.settle();
  });
});
