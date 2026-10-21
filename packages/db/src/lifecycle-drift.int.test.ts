import {
  ActorType,
  AuditEventType,
  DsvStatus,
  EndReason,
  edges,
  endReasonsForPhase,
  reservedEventTypes,
  MainStatus,
  ProfilingExceptionReason,
  ProfilingExceptionStatus,
  ProfilingExceptionSupersededReason,
  ProfilingStatus,
  StatusField,
  TgEntryKind,
  Track,
} from "@transfer/domain";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedProjectIds } from "./seed";
import { call, nightly, resetTestDatabase, testDatabaseUrls } from "./testing";

// AC-17: the SQL side of the lifecycle stays equal to the domain (plan 10, "logic duplicated
// between TypeScript and SQL drifts").
const urls = testDatabaseUrls();
const owner = new Client({ connectionString: urls.owner });
const app = new Client({ connectionString: urls.app });

beforeAll(async () => {
  await Promise.all([owner.connect(), app.connect()]);
  await resetTestDatabase({ seed: true });
});
afterAll(() => Promise.all([owner.end(), app.end()]));

const key = (e: { track: string; from: string | null; to: string; kind: string }) =>
  `${e.track}|${e.from}|${e.to}|${e.kind}`;

describe("lifecycle_edge (AC-17)", () => {
  it("equals the domain's edge list", async () => {
    const { rows } = await owner.query(
      `select track, from_value, to_value, kind, actors::text[] as actors, project_types::text[] as project_types
       from lifecycle_edge`,
    );
    const fromDb = Object.fromEntries(
      rows.map((r) => [
        key({ track: r.track, from: r.from_value, to: r.to_value, kind: r.kind }),
        { actors: r.actors, projectTypes: r.project_types },
      ]),
    );
    const fromDomain: Record<string, { actors: string[]; projectTypes: string[] | null }> = {};
    for (const edge of edges) {
      const entry = (fromDomain[key(edge)] ??= {
        actors: [],
        projectTypes: edge.projectTypes ? [...edge.projectTypes] : null,
      });
      entry.actors.push(edge.actor);
    }
    expect(fromDb).toEqual(fromDomain);
  });
});

describe("enums (AC-17)", () => {
  it.each([
    ["main_status", MainStatus.options],
    ["profiling_status", ProfilingStatus.options],
    ["dsv_status", DsvStatus.options],
    ["lifecycle_track", Track.options],
    ["status_field", StatusField.options],
    ["end_reason", EndReason.options],
    ["tg_entry_kind", TgEntryKind.options],
    ["actor_type", ActorType.options],
    ["profiling_exception_status", ProfilingExceptionStatus.options],
    ["profiling_exception_reason", ProfilingExceptionReason.options],
    ["profiling_exception_superseded_reason", ProfilingExceptionSupersededReason.options],
    ["audit_event_type", AuditEventType.options],
    ["edge_kind", [...TgEntryKind.options, "manual", "system", "activation"]],
  ])("%s equals the domain enum", async (type, values) => {
    const { rows } = await owner.query(`select enum_range(null::${type})::text[] as values`);
    expect(rows[0].values).toEqual(values);
  });
});

describe("end_reason_fits (AC-17)", () => {
  it("equals the domain's phases for every reason", async () => {
    const { rows } = await owner.query(
      `select s::text as status, r::text as reason, end_reason_fits(s, r) as fits
       from unnest(enum_range(null::main_status)) s, unnest(enum_range(null::end_reason)) r`,
    );
    for (const { status, reason, fits } of rows) {
      const phase = status === "withdrawn" ? "pre_tg" : status === "exited" ? "tg" : null;
      expect([status, reason, fits]).toEqual([
        status,
        reason,
        phase !== null && endReasonsForPhase(phase).includes(reason),
      ]);
    }
  });
});

// Person-level events need their participation (table CHECK, 23514).
const personLevel = new Set([
  "sensitive_read",
  "sensitive_write",
  "break_glass_access",
  "document_opened",
  // A manual creation names the participation it created (R32; review of PR 2h-2).
  "participation_created_manually",
]);

describe("record_audit_event (AC-16)", () => {
  it.each(AuditEventType.options)("handles %s as the domain says", async (eventType) => {
    const outcome = await call(app, "record_audit_event", {
      projectId: seedProjectIds.werkNord,
      participationId: null,
      eventType,
      context: nightly,
      reasonCode: "drift_check",
    }).then(
      () => "recorded",
      (error: { code: string; message: string }) =>
        error.code === "P0001" ? error.message : error.code,
    );
    const expected = reservedEventTypes.has(eventType)
      ? "event_type_reserved"
      : personLevel.has(eventType)
        ? "23514"
        : "recorded";
    expect(outcome).toBe(expected);
  });
});
