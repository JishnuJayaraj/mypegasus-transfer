import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError } from "@transfer/api-client";
import {
  ActionButton,
  Button,
  Card,
  DateField,
  InlineNotification,
  Loading,
  SidePanel,
  Stack,
  formatDate,
  parseDisplayDate,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { settlementDatesQuery, useApi } from "../api";
import { usePanelNavigationGuard } from "./panel-guard";

const fields = ["kugFinalSettlementDate", "measure110SettlementDate"] as const;

/**
 * "Abrechnung" on "Einrichtung" (data-protection.md, settlement dates; Q52): the project's final
 * Transfer-KuG and §110 settlement dates, which of them apply, and whether a funding is still
 * unknown. Back office sets them against the dates read; nothing is preset, a date may be
 * cleared. TG entry is never shown as proof of Transfer-KuG.
 */
export function SettlementDatesCard({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const cache = useQueryClient();
  const options = settlementDatesQuery(api, projectId);
  const { queryKey } = options;
  const query = useQuery(options);
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<(typeof fields)[number], string>>({
    kugFinalSettlementDate: "",
    measure110SettlementDate: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expected, setExpected] = useState<Record<(typeof fields)[number], string | null>>();
  const dirty = open && fields.some((f) => values[f] !== "");
  const navigation = usePanelNavigationGuard(dirty);

  if (query.isPending) {
    return (
      <Card id="setup-settlement" title={t("settlement.title")}>
        <Loading label={t("settlement.loading")} />
      </Card>
    );
  }
  if (query.isError) {
    return (
      <Card id="setup-settlement" title={t("settlement.title")}>
        <p>{t("settlement.failed")}</p>
      </Card>
    );
  }
  const view = query.data;
  const parsed = fields.map((f) => [f, parseDisplayDate(values[f])] as const);
  const invalid = parsed.some(([, p]) => !p.ok);

  const openPanel = () => {
    // The panel captures the dates it was opened on: the write compares them (`stale_settlement_dates`).
    setExpected({
      kugFinalSettlementDate: view.kugFinalSettlementDate,
      measure110SettlementDate: view.measure110SettlementDate,
    });
    setValues({
      kugFinalSettlementDate: view.kugFinalSettlementDate
        ? formatDate(view.kugFinalSettlementDate)
        : "",
      measure110SettlementDate: view.measure110SettlementDate
        ? formatDate(view.measure110SettlementDate)
        : "",
    });
    setError(null);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setError(null);
  };
  async function save() {
    if (invalid || !expected) return;
    setBusy(true);
    setError(null);
    try {
      const body = Object.fromEntries(parsed.map(([f, p]) => [f, p.ok ? (p.value ?? null) : null]));
      const result = await api.PUT("/api/v1/projects/{projectId}/settlement-dates", {
        params: { path: { projectId } },
        body: { ...(body as Record<(typeof fields)[number], string | null>), expected },
      });
      if (result.error) setError("failed");
      else close();
    } catch (problem) {
      const code =
        problem instanceof ApiProblemError ? problem.problem.errors?.[0]?.code : undefined;
      setError(code === "stale_settlement_dates" || code === "project_unchanged" ? code : "failed");
    } finally {
      setBusy(false);
      await cache.invalidateQueries({ queryKey });
    }
  }

  return (
    <Card id="setup-settlement" title={t("settlement.title")}>
      <Stack gap={4}>
        <dl className="tp-facts">
          {fields.map((f) => (
            <div key={f}>
              <dt>{t(`settlement.${f}`)}</dt>
              <dd>
                {view[f]
                  ? formatDate(view[f])
                  : t(view.required[f] ? "settlement.missing" : "settlement.notRequired")}
              </dd>
            </div>
          ))}
        </dl>
        {view.required.fundingUnknown && (
          <p>
            <strong>{t("settlement.fundingUnknown")}</strong>
          </p>
        )}
        <p>{t("settlement.hint")}</p>
        {view.capabilities.set && (
          <div>
            <Button kind="tertiary" onClick={openPanel}>
              {t("settlement.edit")}
            </Button>
          </div>
        )}
      </Stack>
      <SidePanel
        open={open}
        title={t("settlement.edit")}
        dirty={dirty}
        onClose={close}
        pendingNavigation={navigation}
      >
        {open && (
          <Stack gap={4}>
            {error && (
              <InlineNotification
                kind="error"
                role="alert"
                title={t(`settlement.errors.${error as "failed"}`)}
                lowContrast
              />
            )}
            {fields.map((f, i) => (
              <DateField
                key={f}
                id={`settlement-${f}`}
                labelText={t(`settlement.${f}`)}
                defaultValue={values[f]}
                invalidText={parsed[i]![1].ok ? undefined : t("settlement.invalidDate")}
                onChange={(value) => setValues((v) => ({ ...v, [f]: value }))}
              />
            ))}
            <ActionButton
              disabled={busy}
              unavailableReason={invalid ? t("settlement.invalidDate") : null}
              onClick={() => void save()}
            >
              {t("settlement.save")}
            </ActionButton>
          </Stack>
        )}
      </SidePanel>
    </Card>
  );
}
