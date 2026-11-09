import { useMutation } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import { dsvBulkMax } from "@transfer/domain";
import {
  ActionButton,
  DateField,
  formatDate,
  InlineNotification,
  parseDisplayDate,
  RadioButton,
  RadioButtonGroup,
  Stack,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "../api";

// "DSV erzeugen" on the work list (process-and-lifecycle.md, the DSV: generation as built; D2): the
// PL or back office generates the DSV for 1–100 selected participations with one deadline, all or
// nothing. The deadline is chosen first (the wave's signing deadline when every selected row is a
// first offer of one wave, else a date entered; nothing preset). Each paper prints the values
// current at the call; what stays for the hand is listed per row afterwards, and the papers are
// opened and printed one by one on the tab "DSV" (the logged opening). German only.

type Item = components["schemas"]["WorklistItem"];
type Wave = components["schemas"]["EntryWave"];
type Generation = components["schemas"]["DsvBulkGenerationResult"]["generations"][number];
type Choice = "wave" | "explicit";

/** A refused batch: the rows by their position in the request, else one general reason. */
type Refusal = { rows: { index: number; code: string }[]; general: string | null };

function refusalOf(error: unknown, t: (key: string) => string): Refusal {
  if (!(error instanceof ApiProblemError)) return { rows: [], general: t("worklist.dsv.failed") };
  if (error.status === 409) return { rows: [], general: t("worklist.dsv.conflict") };
  if (error.status === 503) return { rows: [], general: t("worklist.dsv.unavailable") };
  if (error.status !== 422) return { rows: [], general: t("worklist.dsv.failed") };
  const rows = (error.problem.errors ?? []).flatMap((item) => {
    const match = /^\/items\/(\d+)/.exec("pointer" in item ? (item.pointer ?? "") : "");
    return match ? [{ index: Number(match[1]), code: item.code }] : [];
  });
  return { rows, general: rows.length === 0 ? t("worklist.dsv.failed") : null };
}

export function BulkDsv({
  projectId,
  waves,
  selected,
  onGenerated,
}: {
  projectId: string;
  waves: Wave[];
  /** The rows selected when the panel was opened. */
  selected: Item[];
  onGenerated: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const [choice, setChoice] = useState<Choice>();
  const [typed, setTyped] = useState("");
  const [shownInvalid, setShownInvalid] = useState(false);
  const [result, setResult] = useState<{ generations: Generation[] }>();
  const [refusal, setRefusal] = useState<Refusal>();
  const notAllowed = selected.filter((item) => !item.capabilities.generateDsv).length;
  const tooMany = selected.length > dsvBulkMax;

  // The wave's deadline is offered when it is every row's: one wave, all first offers.
  const waveIds = new Set(selected.map((item) => item.entryWaveId));
  const [onlyWave] = waveIds.size === 1 ? waveIds : [null];
  const waveDeadline =
    selected.every((item) => item.dsvStatus === "not_offered") && onlyWave
      ? (waves.find((wave) => wave.id === onlyWave)?.signingDeadline ?? null)
      : null;
  const parsed = parseDisplayDate(typed);
  const date = parsed.ok ? (parsed.value ?? null) : null;
  const name = (index: number) => {
    const item = selected[index];
    if (!item) return "";
    return (
      [item.lastName, item.firstName].filter(Boolean).join(", ") ||
      item.personnelNumber ||
      `#${index + 1}`
    );
  };

  const generate = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST("/api/v1/projects/{projectId}/dsv/generations", {
        params: { path: { projectId } },
        body: {
          deadline:
            choice === "wave"
              ? { kind: "wave", shown: waveDeadline! }
              : { kind: "explicit", date: date! },
          items: selected.map((item) => ({ participationId: item.id })),
        },
      });
      if (!data) throw error ?? new Error("No answer");
      return data;
    },
    onSuccess: (data) => {
      setRefusal(undefined);
      setResult({ generations: data.generations });
      onGenerated();
    },
    onError: (error) => setRefusal(refusalOf(error, t as never)),
  });

  const reason =
    notAllowed > 0 || tooMany || selected.length === 0
      ? null
      : choice === undefined
        ? t("worklist.dsv.chooseDeadline")
        : choice === "explicit" && date === null
          ? t("worklist.dsv.enterDate")
          : null;
  const open =
    result?.generations.flatMap((generation) => {
      const index = selected.findIndex((item) => item.id === generation.participationId);
      return generation.checklist.length > 0 ? [{ generation, index }] : [];
    }) ?? [];

  return (
    <Stack gap={4}>
      {/* C1: what the generation covers, or why it can't run, next to the button. */}
      <p>
        {t("worklist.batch.applies", {
          count: selected.length - notAllowed,
          total: selected.length,
        })}
      </p>
      <p className="tp-hint" id="dsv-bulk-hint">
        {tooMany
          ? t("worklist.dsv.tooMany")
          : notAllowed > 0
            ? t("worklist.dsv.notAllowed", { count: notAllowed })
            : t("worklist.dsv.hint")}
      </p>
      {!result && (
        <>
          <RadioButtonGroup
            legendText={t("worklist.dsv.deadline")}
            name="dsv-bulk-deadline"
            orientation="vertical"
            valueSelected={choice ?? ""}
            onChange={(value) => setChoice(value as Choice)}
          >
            {[
              ...(waveDeadline
                ? [
                    <RadioButton
                      key="wave"
                      id="dsv-bulk-deadline-wave"
                      value="wave"
                      labelText={t("worklist.dsv.wave", { date: formatDate(waveDeadline) })}
                    />,
                  ]
                : []),
              <RadioButton
                key="explicit"
                id="dsv-bulk-deadline-explicit"
                value="explicit"
                labelText={t("worklist.dsv.explicit")}
              />,
            ]}
          </RadioButtonGroup>
          {choice === "explicit" && (
            <DateField
              id="dsv-bulk-deadline-date"
              labelText={t("worklist.dsv.date")}
              onChange={(value) => {
                setTyped(value);
                setShownInvalid(false);
              }}
              invalidText={shownInvalid ? t("worklist.dsv.dateInvalid") : undefined}
            />
          )}
          <div>
            <ActionButton
              size="md"
              aria-describedby="dsv-bulk-hint"
              disabled={selected.length === 0 || tooMany || notAllowed > 0 || generate.isPending}
              unavailableReason={reason}
              onClick={() => {
                if (choice === "explicit" && date === null) setShownInvalid(true);
                else generate.mutate();
              }}
            >
              {t("worklist.dsv.generate")}
            </ActionButton>
          </div>
        </>
      )}
      {refusal && (
        <InlineNotification
          kind="error"
          role="alert"
          title={refusal.general ?? t("worklist.dsv.refused")}
          onClose={() => setRefusal(undefined)}
          lowContrast
        >
          {refusal.rows.length > 0 && (
            <ul className="tp-list">
              {refusal.rows.map(({ index, code }) => (
                <li key={`${index}-${code}`}>
                  {t("worklist.dsv.refusedRow", {
                    name: name(index),
                    reason: t(`dsv.codes.${code}` as never, {
                      defaultValue: t("worklist.dsv.failed"),
                    }),
                  })}
                </li>
              ))}
            </ul>
          )}
        </InlineNotification>
      )}
      {result && (
        <section className="tp-fieldset" aria-live="polite" data-testid="dsv-bulk-result">
          <Stack gap={3}>
            <p>{t("worklist.dsv.done", { count: result.generations.length })}</p>
            {open.length === 0 ? (
              <p>{t("worklist.dsv.noChecklist")}</p>
            ) : (
              <>
                <p>{t("worklist.dsv.checklist")}</p>
                <ul className="tp-list">
                  {open.map(({ generation, index }) => (
                    <li key={generation.participationId}>
                      {t("worklist.dsv.row", {
                        name: name(index),
                        items: generation.checklist
                          .map((item) => t(`dsv.checklist.keys.${item.key}`))
                          .join(", "),
                      })}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Stack>
        </section>
      )}
    </Stack>
  );
}
