import { describe, expect, it } from "vitest";
import { DsvBulkGenerationRequest, dsvBulkMax } from "./api";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const items = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ participationId: id(i + 1) }));
const deadline = { kind: "explicit", date: "2027-02-01" } as const;

describe("DsvBulkGenerationRequest (D2)", () => {
  it("takes 1 to 100 participations with one deadline", () => {
    expect(dsvBulkMax).toBe(100);
    expect(DsvBulkGenerationRequest.safeParse({ deadline, items: items(1) }).success).toBe(true);
    expect(DsvBulkGenerationRequest.safeParse({ deadline, items: items(100) }).success).toBe(true);
    expect(DsvBulkGenerationRequest.safeParse({ deadline, items: [] }).success).toBe(false);
    expect(DsvBulkGenerationRequest.safeParse({ deadline, items: items(101) }).success).toBe(false);
  });

  it("names a participation once", () => {
    const twice = [...items(2), { participationId: id(1) }];
    expect(DsvBulkGenerationRequest.safeParse({ deadline, items: twice }).success).toBe(false);
  });

  it("carries the deadline choice as the single generation does, nothing else", () => {
    const wave = { kind: "wave", shown: "2027-02-01" } as const;
    expect(DsvBulkGenerationRequest.safeParse({ deadline: wave, items: items(2) }).success).toBe(
      true,
    );
    expect(DsvBulkGenerationRequest.safeParse({ items: items(2) }).success).toBe(false);
    expect(
      DsvBulkGenerationRequest.safeParse({ deadline, items: items(2), extra: 1 }).success,
    ).toBe(false);
    // Each item is an id: a name or a value never travels with it.
    const named = [{ participationId: id(1), name: "Muster" }];
    expect(DsvBulkGenerationRequest.safeParse({ deadline, items: named }).success).toBe(false);
  });
});
