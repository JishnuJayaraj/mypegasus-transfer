import { useMutation } from "@tanstack/react-query";
import { type components } from "@transfer/api-client";
import { kug200bBulkMax } from "@transfer/domain";
import { Button, InlineNotification, Stack } from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "../api";
import { documentNavigation } from "./documents-tab";

// "Kug 200b erzeugen" on the work list (data-protection.md, generated forms and exports; Q179,
// Q197 (8)): the PL generates the Kug 200b for 1–100 selected participations, all or nothing,
// sees each one's handwriting checklist before printing and opens one print file through an
// export link (logged, valid 60 s, re-authorized at the download, nothing stored). German only.

type Item = components["schemas"]["WorklistItem"];
type Generation = components["schemas"]["Kug200bGeneration"];

export function BulkKug200b({
  projectId,
  selected,
  onGenerated,
}: {
  projectId: string;
  selected: Item[];
  onGenerated: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const [result, setResult] = useState<{ generations: Generation[]; names: Map<string, string> }>();
  const [failed, setFailed] = useState(false);
  const notAllowed = selected.filter((item) => !item.capabilities.generateKug200b).length;
  const tooMany = selected.length > kug200bBulkMax;

  const generate = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST("/api/v1/projects/{projectId}/forms/kug200b", {
        params: { path: { projectId } },
        body: { participationIds: selected.map((item) => item.id) },
      });
      if (!data) throw error ?? new Error("No answer");
      return data;
    },
    onSuccess: (data) => {
      setFailed(false);
      // The names as the work list showed them, for the checklist only.
      const names = new Map(
        selected.map((item) => [
          item.id,
          [item.lastName, item.firstName].filter(Boolean).join(", ") ||
            (item.personnelNumber ?? ""),
        ]),
      );
      setResult({ generations: data.generations, names });
      onGenerated();
    },
    onError: () => setFailed(true),
  });

  const print = useMutation({
    mutationFn: async (documentIds: string[]) => {
      const { data, error } = await api.POST("/api/v1/exports/{kind}", {
        params: { path: { kind: "kug200b_print" } },
        body: { documentIds },
      });
      if (!data) throw error ?? new Error("No answer");
      documentNavigation.assign(data.url);
    },
    onError: () => setFailed(true),
  });

  const open = result?.generations.filter((g) => g.checklist.length > 0) ?? [];
  return (
    <Stack gap={4}>
      <div className="tp-bulk-actions">
        <Button
          size="md"
          kind="tertiary"
          disabled={selected.length === 0 || tooMany || notAllowed > 0 || generate.isPending}
          onClick={() => generate.mutate()}
        >
          {t("worklist.kug200b.generate")}
        </Button>
        <span className="tp-hint">
          {tooMany
            ? t("worklist.kug200b.tooMany")
            : notAllowed > 0
              ? t("worklist.kug200b.notAllowed", { count: notAllowed })
              : t("worklist.kug200b.hint")}
        </span>
      </div>
      {failed && (
        <InlineNotification
          kind="error"
          role="alert"
          title={t("worklist.kug200b.failed")}
          onClose={() => setFailed(false)}
          lowContrast
        />
      )}
      {result && (
        <section className="tp-fieldset" aria-live="polite" data-testid="kug200b-bulk-result">
          <Stack gap={3}>
            <p>{t("worklist.kug200b.done", { count: result.generations.length })}</p>
            {open.length === 0 ? (
              <p>{t("worklist.kug200b.noChecklist")}</p>
            ) : (
              <>
                <p>{t("worklist.kug200b.checklist")}</p>
                <ul className="tp-list">
                  {open.map((generation) => (
                    <li key={generation.participationId}>
                      {t("worklist.kug200b.row", {
                        name: result.names.get(generation.participationId) ?? "",
                        items: generation.checklist.map((item) => item.label).join(", "),
                      })}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="tp-inline-actions">
              <Button
                size="md"
                disabled={print.isPending}
                onClick={() => print.mutate(result.generations.map((g) => g.documentId))}
              >
                {t("worklist.kug200b.print")}
              </Button>
              <Button kind="ghost" size="md" onClick={() => setResult(undefined)}>
                {t("worklist.kug200b.close")}
              </Button>
            </div>
          </Stack>
        </section>
      )}
    </Stack>
  );
}
