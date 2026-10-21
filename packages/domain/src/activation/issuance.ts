import type { MainStatus } from "../lifecycle/enums";
import type { ProjectStatus } from "../project";
import type { ActivationChannel } from "./model";

export type IssuanceRefusal =
  | "participation_closed"
  | "project_not_active"
  | "birth_date_required"
  | "address_required"
  | "identity_not_checked"
  | "before_cutoff"
  | "open_code_exists"
  | "already_activated";

export interface IssuanceFacts {
  projectStatus: ProjectStatus;
  participationStatus: MainStatus;
  channel: ActivationChannel;
  hasBirthDate: boolean;
  hasPostalAddress: boolean;
  identityChecked: boolean;
  beforeCutoff: boolean;
  hasOpenCode: boolean;
  replaceOpenCode: boolean;
  accountActivated: boolean;
}

const terminal = new Set<MainStatus>(["withdrawn", "ta_completed", "exited"]);
const beforeAdmission = new Set<MainStatus>(["imported", "contacted", "unreachable"]);

/** Pure preflight for the rules the database re-checks under the participation lock (D15–D17). */
export function issuanceRefusals(facts: IssuanceFacts): IssuanceRefusal[] {
  const refusals: IssuanceRefusal[] = [];
  if (facts.projectStatus !== "active") refusals.push("project_not_active");
  if (terminal.has(facts.participationStatus)) refusals.push("participation_closed");
  if (facts.accountActivated) refusals.push("already_activated");
  if (beforeAdmission.has(facts.participationStatus) && !facts.beforeCutoff) {
    refusals.push("before_cutoff");
  }
  if (facts.channel === "letter") {
    if (!facts.hasBirthDate) refusals.push("birth_date_required");
    if (!facts.hasPostalAddress) refusals.push("address_required");
  }
  if (facts.channel === "in_person" && !facts.identityChecked) {
    refusals.push("identity_not_checked");
  }
  if (facts.hasOpenCode && !facts.replaceOpenCode) refusals.push("open_code_exists");
  return refusals;
}
