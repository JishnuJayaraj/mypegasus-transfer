import type { WorklistItem } from "../projection";

/** A synthetic work list row (tests only): an informed participation without anything open. */
export function item(overrides: Partial<WorklistItem> = {}): WorklistItem {
  return {
    id: "00000000-0000-4000-8000-0000000000a1",
    status: "informed",
    profilingStatus: "not_started",
    dsvStatus: "not_offered",
    entryWaveId: null,
    placementAgenturKey: null,
    personnelNumber: "P-0001",
    lastName: "Muster",
    firstName: "Max",
    consultants: [],
    activationStatus: { account: "not_activated", code: "none", issuedAt: null, expiresAt: null },
    privacyNoticeState: {
      state: "provided",
      dueOn: "2027-01-01",
      providedAt: "2026-12-01T09:00:00.000Z",
    },
    actions: [],
    deadlines: [],
    flags: [],
    portal: "not_reachable",
    reminder: null,
    appointments: { next: null, items: [] },
    capabilities: {
      assignEntryWave: false,
      issueActivationCode: false,
      recordHandover: false,
      revokeActivationCode: false,
      providePrivacyNotice: false,
      remind: { allowed: false, code: null, channel: null },
      invite: { allowed: false, channel: null },
    },
    ...overrides,
  };
}
