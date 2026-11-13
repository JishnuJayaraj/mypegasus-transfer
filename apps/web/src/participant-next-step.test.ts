import type { components } from "@transfer/api-client";
import { describe, expect, it } from "vitest";
import { primaryStep, type StepViewer } from "./components/participant-next-step";
import { worklistItem } from "./test-utils";

// The participant page's one primary action (ui-patterns.md, principle 3 and C2): the next step
// of the participation where the viewer may take it, else none. Synthetic values only.

type Detail = components["schemas"]["ParticipationDetail"];
type Item = components["schemas"]["WorklistItem"];

const tabs = ["self-service", "profiling", "asu", "dsv", "documents", "appointments"] as const;

function viewer(
  options: {
    taTg?: boolean;
    without?: (typeof tabs)[number][];
    capabilities?: Partial<Detail["capabilities"]>;
    detail?: Partial<Detail>;
  } = {},
): StepViewer {
  const detail = {
    capabilities: {
      assignEntryWave: false,
      setParticipationDates: false,
      issueActivationCode: false,
      providePrivacyNotice: false,
      ...options.capabilities,
    },
    activationStatus: { account: "not_activated", code: "none" },
    privacyNoticeState: { state: "due", dueOn: "2026-11-15", providedAt: null },
    ...options.detail,
  } as unknown as Detail;
  return {
    detail,
    taTg: options.taTg ?? true,
    hasTab: (tab) => !(options.without ?? []).includes(tab),
  };
}

const item = (overrides: Parameters<typeof worklistItem>[0]) =>
  worklistItem(overrides) as unknown as Item;
const place = (row: Item | undefined, who: StepViewer) => primaryStep(row, who)?.target ?? null;

const tasks = (recordOutcome: boolean) => ({
  detail: {
    baReportingTasks: [{ capabilities: { recordOutcome } }],
  } as unknown as Partial<Detail>,
});

describe("the participant page's primary action", () => {
  it("is none without the work list's row or with nothing open", () => {
    expect(primaryStep(undefined, viewer())).toBeNull();
    expect(primaryStep(item({}), viewer())).toBeNull();
  });

  it("is the next step in C2's order, never a later one", () => {
    const row = item({
      actions: [{ kind: "field", key: "mobile", state: "missing" }],
      deadlines: [
        { kind: "tl407_submission", date: "2026-10-30", state: "upcoming" },
        { kind: "asu_due", date: "2026-10-20", state: "overdue" },
      ],
    });
    expect(primaryStep(row, viewer())).toMatchObject({
      step: { source: "deadline", kind: "asu_due", tier: 1 },
      target: { tab: "asu" },
    });
    // The next step's tab isn't the viewer's: none, not the second item's.
    expect(primaryStep(row, viewer({ without: ["asu"] }))).toBeNull();
  });

  it.each([
    [
      { deadlines: [{ kind: "tl407_submission", date: "2026-10-30", state: "upcoming" }] },
      "profiling",
    ],
    [{ caseItems: [{ kind: "evidence_invalidated", date: "2026-10-01" }] }, "documents"],
    [{ caseItems: [{ kind: "entry_clarification", date: "2026-10-01" }] }, "dsv"],
    [{ actions: [{ kind: "field", key: "mobile", state: "missing" }] }, "self-service"],
    [{ actions: [{ kind: "document", key: "cv", state: "rejected" }] }, "documents"],
  ] as const)("opens the tab that resolves %j, only for a viewer who has it", (state, tab) => {
    const row = item(state as Parameters<typeof worklistItem>[0]);
    expect(place(row, viewer())).toEqual({ tab });
    expect(place(row, viewer({ without: [tab] }))).toBeNull();
  });

  const offer = item({
    deadlines: [{ kind: "offer_deadline", date: "2026-10-20", state: "overdue" }],
  });
  const wave = item({ flags: ["informed_without_wave_at_cutoff"] });
  const notice = item({
    deadlines: [{ kind: "privacy_notice", date: "2026-11-15", state: "upcoming" }],
  });
  const report = item({ agenturItems: [{ kind: "ba_report_pending", date: "2026-10-01" }] });

  it("opens the contractual dates only for who may change them now, in a ta_tg project", () => {
    const may = { capabilities: { setParticipationDates: true } };
    expect(place(offer, viewer(may))).toEqual({ anchor: "participant-dates" });
    expect(place(offer, viewer())).toBeNull();
    expect(place(offer, viewer({ ...may, taTg: false }))).toBeNull();
    // The wave's choice has its own capability.
    expect(place(wave, viewer(may))).toBeNull();
    expect(place(wave, viewer({ capabilities: { assignEntryWave: true } }))).toEqual({
      anchor: "participant-dates",
    });
  });

  it("opens the privacy notice's card only for who may provide the notice", () => {
    expect(place(notice, viewer())).toBeNull();
    expect(place(notice, viewer({ capabilities: { providePrivacyNotice: true } }))).toEqual({
      anchor: "participant-activation",
    });
  });

  it("opens the BA reports only for who may record an outcome", () => {
    expect(place(report, viewer())).toBeNull();
    expect(place(report, viewer(tasks(false)))).toBeNull();
    expect(place(report, viewer(tasks(true)))).toEqual({ anchor: "participant-ba" });
    expect(place(report, viewer({ ...tasks(true), taTg: false }))).toBeNull();
  });
});
