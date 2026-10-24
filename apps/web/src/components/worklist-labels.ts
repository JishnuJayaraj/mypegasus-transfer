import type {
  ActivationFilter,
  AppointmentFilter,
  LifecycleFlag,
  MainStatus,
  PortalReach,
  ProfilingStatus,
} from "@transfer/domain";
import type { components } from "@transfer/api-client";
import { useTranslation } from "react-i18next";

type DsvStatus = components["schemas"]["WorklistItem"]["dsvStatus"];
type NoticeState = components["schemas"]["PrivacyNoticeState"]["state"];

/** The groups whose keys are codes with a label of their own (the waves and deadlines aren't). */
export type LabelledGroup =
  | "statuses"
  | "profilingStatuses"
  | "dsvStatuses"
  | "activation"
  | "notice"
  | "flags"
  | "portal"
  | "appointments";

/** The label of a code, as the work list's columns and filters show it. */
export function useCountLabel() {
  const { t } = useTranslation();
  return (group: LabelledGroup, key: string): string => {
    switch (group) {
      case "statuses":
        return t(`participants.statuses.${key as MainStatus}`);
      case "profilingStatuses":
        return t(`participants.profilingStatuses.${key as ProfilingStatus}`);
      case "dsvStatuses":
        return t(`participants.dsvStatuses.${key as DsvStatus}`);
      case "activation": {
        const value = key as ActivationFilter;
        return value === "activated"
          ? t("activation.status.activated")
          : t(`activation.code.${value}`);
      }
      case "notice":
        return t(`worklist.noticeStates.${key as NoticeState}`);
      case "flags":
        return t(`worklist.flags.${key as LifecycleFlag}`);
      case "portal":
        return t(`worklist.portal.${key as PortalReach}`);
      case "appointments":
        return t(`worklist.appointmentFilter.${key as AppointmentFilter}`);
    }
  };
}
