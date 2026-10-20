import { describe, expect, it } from "vitest";
import { CreateRegionInput, UpdateRegionInput } from "./regions";
import { AddMemberInput, AssignParticipationsInput, assignmentLimit } from "./team";

const id = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;

describe("regions (D7)", () => {
  it("takes an upper-case code and a name", () => {
    expect(CreateRegionInput.parse({ code: "NORD", name: " Niederlassung Nord " })).toEqual({
      code: "NORD",
      name: "Niederlassung Nord",
    });
    expect(CreateRegionInput.safeParse({ code: "BY-SUED", name: "Süd" }).success).toBe(true);
    for (const code of ["nord", "-NORD", "NORD-", "N O", "", "A".repeat(21)]) {
      expect([code, CreateRegionInput.safeParse({ code, name: "x" }).success]).toEqual([
        code,
        false,
      ]);
    }
  });

  it("changes at least one field", () => {
    expect(UpdateRegionInput.safeParse({ name: "Nord" }).success).toBe(true);
    expect(UpdateRegionInput.safeParse({}).success).toBe(false);
  });
});

describe("team inputs (D9, D10)", () => {
  it("adds a member in one project role", () => {
    expect(AddMemberInput.safeParse({ staffUserId: id(1), role: "consultant" }).success).toBe(true);
    expect(AddMemberInput.safeParse({ staffUserId: id(1), role: "admin" }).success).toBe(false);
  });

  it("assigns 1 to 500 distinct participations to one consultant", () => {
    const ids = Array.from({ length: assignmentLimit }, (_, i) => id(i));
    expect(
      AssignParticipationsInput.safeParse({ staffUserId: id(9), participationIds: ids }).success,
    ).toBe(true);
    expect(
      AssignParticipationsInput.safeParse({
        staffUserId: id(9),
        participationIds: [...ids, id(999)],
      }).success,
    ).toBe(false);
    expect(
      AssignParticipationsInput.safeParse({ staffUserId: id(9), participationIds: [] }).success,
    ).toBe(false);
    const duplicate = AssignParticipationsInput.safeParse({
      staffUserId: id(9),
      participationIds: [id(1), id(1)],
    });
    expect(
      duplicate.error?.issues.map((i) => (i as { params?: { code?: string } }).params?.code),
    ).toEqual(["duplicate_participation"]);
  });
});
