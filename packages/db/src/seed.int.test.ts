import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "./client";
import { projectEntryWave, staffUser } from "./schema";
import { seed, seedProjectIds, seedWaves } from "./seed";
import { resetTestDatabase, testDatabaseUrls } from "./testing";

const db = createDb(testDatabaseUrls().owner);
afterAll(() => db.$client.end());
beforeEach(() => resetTestDatabase());

const waves = () =>
  db
    .select({
      id: projectEntryWave.id,
      code: projectEntryWave.code,
      latestEntryDate: projectEntryWave.latestEntryDate,
    })
    .from(projectEntryWave)
    .orderBy(projectEntryWave.code);

describe("the base seed", () => {
  it("adds the synthetic regional operations manager and Werk Nord's waves, idempotently", async () => {
    await seed(db);
    await seed(db);
    expect(await waves()).toEqual(
      seedWaves.map(({ id, code, latestEntryDate }) => ({ id, code, latestEntryDate })),
    );
    const roles = await db.select({ role: staffUser.role }).from(staffUser);
    expect(roles.map((r) => r.role)).toContain("regional_operations_manager");
  });

  it("gives a migrated W1 (no latest entry date) the seed's dates and keeps its id", async () => {
    await seed(db);
    await db.delete(projectEntryWave);
    const migrated = "00000000-0000-4000-b000-0000000000ff";
    await db.insert(projectEntryWave).values({
      id: migrated,
      projectId: seedProjectIds.werkNord,
      code: "W1",
      name: "W1",
    });
    await seed(db);
    expect((await waves())[0]).toEqual({ id: migrated, code: "W1", latestEntryDate: "2027-03-15" });
  });
});
