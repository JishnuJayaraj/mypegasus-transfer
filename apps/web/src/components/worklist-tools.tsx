import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  ActionsFilter,
  ActivationFilter,
  AgenturFilter,
  AppointmentFilter,
  DeadlineKind,
  DeadlineState,
  DsvStatus,
  LifecycleFlag,
  MainStatus,
  PortalReach,
  ProfilingStatus,
  remainingFlags,
  type WorklistFilter,
} from "@transfer/domain";
import {
  Button,
  DismissibleTag,
  InlineNotification,
  Select,
  SelectItem,
  Stack,
  useToast,
} from "@transfer/ui";
import { memo, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { entryWavesQuery, useApi, worklistQuery } from "../api";
import type de from "../locales/de/translation.json";
import { useCountLabel } from "./worklist-labels";

type Wave = components["schemas"]["EntryWave"];
type ListItem = components["schemas"]["WorklistItem"];
type Option = { value: string; text: string };

const codes = (values: readonly string[], text: (value: string) => string): Option[] =>
  values.map((value) => ({ value, text: text(value) }));

type FilterKey = keyof WorklistFilter;

/**
 * The filter panel's groups (the plan of Slice 6b, D6): every code filter once. "Offene Punkte"
 * (the participant's actions) sits with the statuses.
 */
const groups: { key: keyof typeof de.worklist.filterGroups; filters: FilterKey[] }[] = [
  { key: "status", filters: ["status", "profilingStatus", "dsvStatus", "flag", "actions"] },
  { key: "dates", filters: ["deadlineKind", "deadlineState", "appointment"] },
  { key: "responsibility", filters: ["consultant", "wave"] },
  { key: "reach", filters: ["portal", "activation", "notice", "agentur"] },
];

/** The options of each code filter and their labels, for the fields and the active-filter tags. */
function useFilterOptions({
  taTg,
  waves,
  consultants,
}: {
  taTg: boolean;
  waves: Wave[];
  consultants: { staffUserId: string; displayName: string }[];
}): (key: FilterKey) => Option[] | null {
  const { t } = useTranslation();
  const label = useCountLabel();
  return (key) => {
    switch (key) {
      case "status":
        return codes(MainStatus.options, (v) => label("statuses", v));
      case "profilingStatus":
        return codes(ProfilingStatus.options, (v) => label("profilingStatuses", v));
      case "dsvStatus":
        return taTg ? codes(DsvStatus.options, (v) => label("dsvStatuses", v)) : null;
      case "wave":
        return taTg
          ? [
              ...waves.map((wave) => ({ value: wave.id, text: `${wave.code} – ${wave.name}` })),
              { value: "none", text: t("worklist.filters.noWave") },
            ]
          : null;
      case "consultant":
        return [
          ...consultants.map((c) => ({ value: c.staffUserId, text: c.displayName })),
          { value: "none", text: t("worklist.filters.noConsultant") },
        ];
      case "actions":
        return codes(ActionsFilter.options, (v) =>
          t(`worklist.actionsFilter.${v as ActionsFilter}`),
        );
      case "deadlineKind":
        return codes(DeadlineKind.options, (v) => t(`worklist.deadlineKinds.${v as DeadlineKind}`));
      case "deadlineState":
        return codes(DeadlineState.options, (v) =>
          t(`worklist.deadlineStates.${v as DeadlineState}`),
        );
      case "flag":
        return [
          { value: "any", text: t("worklist.filters.anyFlag") },
          ...codes(remainingFlags(LifecycleFlag.options), (v) => label("flags", v)),
        ];
      case "portal":
        return codes(PortalReach.options, (v) => label("portal", v));
      case "appointment":
        return codes(AppointmentFilter.options, (v) => label("appointments", v));
      case "agentur":
        return codes(AgenturFilter.options, (v) => label("agentur", v));
      case "activation":
        return codes(ActivationFilter.options, (v) => label("activation", v));
      case "notice":
        return codes(["provided", "due", "overdue"], (v) => label("notice", v));
    }
  };
}

type FilterProps = {
  filter: WorklistFilter;
  onChange: (filter: WorklistFilter) => void;
  taTg: boolean;
  waves: Wave[];
  consultants: { staffUserId: string; displayName: string }[];
};

const without = (filter: WorklistFilter, key: FilterKey): WorklistFilter => {
  const { [key]: _removed, ...rest } = filter;
  return rest;
};

/**
 * The filter panel's fields: codes only, kept in the route's search params (data-protection.md,
 * the work list and the dashboard), applied at once. "Alle" removes the condition.
 */
export const WorklistFilterFields = memo(function WorklistFilterFields(props: FilterProps) {
  const { t } = useTranslation();
  const { filter, onChange } = props;
  const options = useFilterOptions(props);
  return (
    <Stack gap={6}>
      {groups.map((group) => (
        <fieldset key={group.key} className="tp-filter-group">
          <legend>{t(`worklist.filterGroups.${group.key}`)}</legend>
          <Stack gap={5}>
            {group.filters.map((key) => {
              const choices = options(key);
              if (!choices) return null;
              return (
                <Select
                  key={key}
                  id={`worklist-filter-${key}`}
                  labelText={t(`worklist.filters.${key}`)}
                  value={filter[key] ?? ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    onChange(
                      value ? { ...without(filter, key), [key]: value } : without(filter, key),
                    );
                  }}
                >
                  <SelectItem value="" text={t("worklist.filters.all")} />
                  {choices.map((option) => (
                    <SelectItem key={option.value} value={option.value} text={option.text} />
                  ))}
                </Select>
              );
            })}
          </Stack>
        </fieldset>
      ))}
    </Stack>
  );
});

/** The active filters as dismissible tags above the table, each removing its condition. */
export function ActiveFilterTags(props: FilterProps) {
  const { t } = useTranslation();
  const { filter, onChange } = props;
  const options = useFilterOptions(props);
  const active = (Object.keys(filter) as FilterKey[]).flatMap((key) => {
    const value = filter[key];
    const text = options(key)?.find((option) => option.value === value)?.text;
    return text ? [{ key, text: `${t(`worklist.filters.${key}`)}: ${text}` }] : [];
  });
  if (active.length === 0) return null;
  return (
    <ul className="tp-filter-tags" aria-label={t("worklist.activeFilters")}>
      {active.map(({ key, text }) => (
        <li key={key}>
          <DismissibleTag
            type="high-contrast"
            text={text}
            title={t("worklist.removeFilter", { filter: text })}
            dismissTooltipLabel={t("worklist.removeFilter", { filter: text })}
            onClose={() => onChange(without(filter, key))}
          />
        </li>
      ))}
    </ul>
  );
}

/** A refused row: its index in the request and its code. */
type Refusal = { index: number | null; code: string };

/** The refused rows of a 422, by their `/participationIds/<i>` pointers. */
function refusalsOf(error: unknown): Refusal[] {
  if (!(error instanceof ApiProblemError) || error.status !== 422) return [];
  return (error.problem.errors ?? []).map((item) => {
    const match = /^\/participationIds\/(\d+)$/.exec("pointer" in item ? (item.pointer ?? "") : "");
    return { index: match ? Number(match[1]) : null, code: item.code };
  });
}

/**
 * "Eintrittswelle zuweisen" (process-and-lifecycle.md, assigning a wave): one wave for the
 * selected rows, all or nothing. A refusal says first that nothing was assigned, then lists each
 * refused row by Personalnummer with its reason.
 */
export function BulkWave({
  projectId,
  waves,
  selected,
  onAssigned,
  onDirtyChange,
}: {
  projectId: string;
  waves: Wave[];
  /** The rows selected when the panel was opened. */
  selected: ListItem[];
  onAssigned: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [waveId, setWaveId] = useState("");
  // A chosen wave is input until assigned (ui-patterns.md, C4); a layout effect, so an Escape
  // right after choosing already asks.
  useLayoutEffect(() => onDirtyChange(waveId !== ""), [waveId, onDirtyChange]);
  const [refused, setRefused] = useState<{ rows: Refusal[]; items: ListItem[] } | null>(null);
  const assign = useMutation({
    mutationFn: async (items: ListItem[]) => {
      const { data } = await api.POST("/api/v1/projects/{projectId}/entry-wave-assignments", {
        params: { path: { projectId } },
        body: { waveId, participationIds: items.map((item) => item.id) },
      });
      return data!;
    },
    onSuccess: async ({ assigned, unchanged }) => {
      setRefused(null);
      onAssigned();
      showToast({ title: t("worklist.wave.done", { assigned, unchanged }) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: worklistQuery(api, projectId).queryKey }),
        queryClient.invalidateQueries({ queryKey: entryWavesQuery(api, projectId).queryKey }),
      ]);
    },
    onError: (error, items) => setRefused({ rows: refusalsOf(error), items }),
  });
  const reason = (code: string) =>
    code === "participation_not_found"
      ? t("worklist.wave.participation_not_found")
      : t(`participant.waveErrors.${code}` as never, { defaultValue: t("worklist.wave.failed") });
  return (
    <Stack gap={5}>
      {refused && (
        <div>
          <InlineNotification
            kind="error"
            title={t("worklist.wave.refused")}
            subtitle={refused.rows.length === 0 ? t("worklist.wave.failed") : undefined}
            onClose={() => setRefused(null)}
          />
          {refused.rows.length > 0 && (
            <>
              <p>{t("worklist.wave.refusedRows")}</p>
              <ul className="tp-list">
                {refused.rows.map(({ index, code }) => {
                  const item = index === null ? undefined : refused.items[index];
                  const name = item?.personnelNumber ?? t("participants.open");
                  return (
                    <li key={`${index}-${code}`}>
                      {index === null
                        ? reason(code)
                        : t("worklist.wave.row", { name, reason: reason(code) })}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
      <Select
        id="bulk-wave"
        labelText={t("worklist.wave.choose")}
        value={waveId}
        onChange={(event) => setWaveId(event.target.value)}
      >
        <SelectItem value="" text={t("worklist.wave.chooseWave")} />
        {waves.map((wave) => (
          <SelectItem key={wave.id} value={wave.id} text={`${wave.code} – ${wave.name}`} />
        ))}
      </Select>
      <div>
        <Button
          disabled={!waveId || selected.length === 0 || assign.isPending}
          onClick={() => assign.mutate(selected)}
        >
          {t("worklist.wave.assign", { count: selected.length })}
        </Button>
      </div>
    </Stack>
  );
}
