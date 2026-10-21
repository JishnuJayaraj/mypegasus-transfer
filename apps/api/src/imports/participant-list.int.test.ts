import { ParticipationPage } from "@transfer/domain";
import { describe, expect, it } from "vitest";
import { expectProblem, readJson } from "../testing";
import { app, auth, fixture, importFile, werkNord, verwaltung } from "./import-testing";

// Slice 2 plan 5.12 (PR 2g-2, AC-33): the participant list pages by (created_at, id) and returns
// only the fields the viewer may list.
const list = (projectId: string, query = "", user = "projectLead") =>
  app.request(`/api/v1/projects/${projectId}/participations${query}`, { headers: auth[user] });

describe("GET /api/v1/projects/{projectId}/participations (AC-33)", () => {
  it("lists the imported participations with their person fields, page by page", async () => {
    expect((await importFile(fixture("teilnehmer-beispiel.csv"))).status).toBe(200);
    const first = await readJson(await list(werkNord, "?limit=5"), ParticipationPage);
    expect(first.items).toHaveLength(5);
    expect(first.nextCursor).not.toBeNull();
    const second = await readJson(
      await list(werkNord, `?limit=5&cursor=${first.nextCursor}`),
      ParticipationPage,
    );
    const third = await readJson(
      await list(werkNord, `?limit=5&cursor=${second.nextCursor}`),
      ParticipationPage,
    );
    const all = [...first.items, ...second.items, ...third.items];
    // One import is one transaction, so its participations share `created_at` and follow in the
    // order of their ids: stable across pages, not the file's order.
    expect(all.map((p) => p.personnelNumber).toSorted()).toEqual(
      Array.from({ length: 12 }, (_, i) => `BSP-${String(i + 1).padStart(4, "0")}`),
    );
    expect(all.find((p) => p.personnelNumber === "BSP-0001")).toMatchObject({
      status: "imported",
      profilingStatus: "not_started",
      dsvStatus: "not_offered",
      entryWaveId: null,
      lastName: "Mustermann",
      firstName: "Erika",
    });
    expect(third.nextCursor).toBeNull();
    // No date of birth, address or contact detail in a list (the fields are not listed at all).
    expect(Object.keys(all[0]!).toSorted()).toEqual(
      [
        "activationCapabilities",
        "activationStatus",
        "consultants",
        "dsvStatus",
        "entryWaveId",
        "firstName",
        "id",
        "lastName",
        "personnelNumber",
        "placementAgenturKey",
        "privacyNoticeState",
        "profilingStatus",
        "status",
      ].toSorted(),
    );
  });

  it("gives the consultant without assignments and the org roles no participant data (403)", async () => {
    await importFile(fixture("teilnehmer-beispiel.csv"));
    for (const user of ["consultant", "admin", "regionalOperationsManager"]) {
      await expectProblem(await list(werkNord, "", user), 403, "forbidden");
    }
  });

  it("is a 404 for a project the viewer can't see and for a malformed cursor", async () => {
    await expectProblem(await list(crypto.randomUUID()), 404, "not-found");
    const bad = await expectProblem(await list(werkNord, "?cursor=x"), 400, "validation-error");
    expect(bad.errors?.[0]?.code).toBe("invalid_cursor");
  });

  it("lists nothing for a project without participations", async () => {
    expect(await readJson(await list(verwaltung), ParticipationPage)).toEqual({
      items: [],
      nextCursor: null,
    });
  });
});
