import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  ActionsFilter,
  ActivationFilter,
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
import { Button, InlineNotification, Select, SelectItem, useToast } from "@transfer/ui";
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { entryWavesQuery, useApi, worklistQuery } from "../api";
import { useCountLabel } from "./worklist-labels";

type Wave = components["schemas"]["EntryWave"];
type ListItem = components["schemas"]["WorklistItem"];
type Option = { value: string; text: string };

const codes = (values: readonly string[], text: (value: string) => string): Option[] =>
  values.map((value) => ({ value, text: text(value) }));

/**
 * The work list's filter bar: codes only, kept in the route's search params (data-protection.md,
 * the work list and the dashboard). "Alle" removes the condition.
 */
export const WorklistFilters = memo(function WorklistFilters({
  filter,
  onChange,
  taTg,
  waves,
  consultants,
}: {
  filter: WorklistFilter;
  onChange: (filter: WorklistFilter) => void;
  taTg: boolean;
  waves: Wave[];
  consultants: { staffUserId: string; displayName: string }[];
}) {
  const { t } = useTranslation();
  const label = useCountLabel();
  const field = <K extends keyof WorklistFilter>(key: K, options: Option[]) => (
    <Select
      key={key}
      id={`worklist-filter-${key}`}
      labelText={t(`worklist.filters.${key}`)}
      value={filter[key] ?? ""}
      onChange={(event) => {
        const { [key]: _removed, ...rest } = filter;
        const value = event.target.value;
        onChange(value ? { ...rest, [key]: value } : rest);
      }}
    >
      <SelectItem value="" text={t("worklist.filters.all")} />
      {options.map((option) => (
        <SelectItem key={option.value} value={option.value} text={option.text} />
      ))}
    </Select>
  );
  return (
    <fieldset className="tp-section">
      <legend>{t("worklist.filters.title")}</legend>
      <div className="tp-filters">
        {field(
          "status",
          codes(MainStatus.options, (v) => label("statuses", v)),
        )}
        {field(
          "profilingStatus",
          codes(ProfilingStatus.options, (v) => label("profilingStatuses", v)),
        )}
        {taTg &&
          field(
            "dsvStatus",
            codes(DsvStatus.options, (v) => label("dsvStatuses", v)),
          )}
        {taTg &&
          field("wave", [
            ...waves.map((wave) => ({ value: wave.id, text: `${wave.code} – ${wave.name}` })),
            { value: "none", text: t("worklist.filters.noWave") },
          ])}
        {field("consultant", [
          ...consultants.map((c) => ({ value: c.staffUserId, text: c.displayName })),
          { value: "none", text: t("worklist.filters.noConsultant") },
        ])}
        {field(
          "actions",
          codes(ActionsFilter.options, (v) => t(`worklist.actionsFilter.${v as ActionsFilter}`)),
        )}
        {field(
          "deadlineKind",
          codes(DeadlineKind.options, (v) => t(`worklist.deadlineKinds.${v as DeadlineKind}`)),
        )}
        {field(
          "deadlineState",
          codes(DeadlineState.options, (v) => t(`worklist.deadlineStates.${v as DeadlineState}`)),
        )}
        {field("flag", [
          { value: "any", text: t("worklist.filters.anyFlag") },
          ...codes(remainingFlags(LifecycleFlag.options), (v) => label("flags", v)),
        ])}
        {field(
          "portal",
          codes(PortalReach.options, (v) => label("portal", v)),
        )}
        {field(
          "activation",
          codes(ActivationFilter.options, (v) => label("activation", v)),
        )}
        {field(
          "notice",
          codes(["provided", "due", "overdue"], (v) => label("notice", v)),
        )}
      </div>
      {Object.keys(filter).length > 0 && (
        <Button kind="ghost" size="sm" onClick={() => onChange({})}>
          {t("worklist.filters.reset")}
        </Button>
      )}
    </fieldset>
  );
});

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
}: {
  projectId: string;
  waves: Wave[];
  selected: ListItem[];
  onAssigned: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [waveId, setWaveId] = useState("");
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
    <section className="tp-section" aria-label={t("worklist.wave.title")}>
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
      <div className="tp-bulk-actions">
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
        <Button
          kind="secondary"
          disabled={!waveId || selected.length === 0 || assign.isPending}
          onClick={() => assign.mutate(selected)}
        >
          {t("worklist.wave.assign", { count: selected.length })}
        </Button>
      </div>
    </section>
  );
}
