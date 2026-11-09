import { useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  ActionButton,
  Button,
  Card,
  DateField,
  InlineNotification,
  SidePanel,
  Stack,
  formatDate,
  parseDisplayDate,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "../api";
import { usePanelNavigationGuard } from "./panel-guard";

type View = components["schemas"]["DsvView"];

/**
 * "Kunde informieren" (process-and-lifecycle.md, the customer notice; Q46 verify): after a
 * cancellation-based withdrawal, until the PL records the day the customer was informed. Once,
 * not in the future, not before the withdrawal; nothing preset. The customer's data whitelist is
 * unchanged: the app records that the PL told the customer, never what.
 */
export function DsvCustomerNotice({ view }: { view: View }) {
  const { t } = useTranslation();
  const api = useApi();
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigation = usePanelNavigationGuard(open && value !== "");
  const notice = view.customerNotice;
  if (notice === null) return null;
  const parsed = parseDisplayDate(value);
  const close = () => {
    setOpen(false);
    setValue("");
    setError(null);
  };
  async function save() {
    if (!parsed.ok || !parsed.value) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.POST(
        "/api/v1/participations/{participationId}/dsv/customer-notice",
        {
          params: { path: { participationId: view.participationId } },
          body: { notifiedOn: parsed.value },
        },
      );
      if (result.error) setError("failed");
      else close();
    } catch (problem) {
      const code =
        problem instanceof ApiProblemError && problem.status === 422
          ? problem.problem.errors?.[0]?.code
          : undefined;
      setError(
        code === "date_in_future" ||
          code === "notice_before_withdrawal" ||
          code === "notice_recorded"
          ? code
          : "failed",
      );
    } finally {
      setBusy(false);
      await cache.invalidateQueries({ queryKey: ["participations", view.participationId] });
    }
  }
  return (
    <Card title={t("dsv.customerNotice.title")} level={3}>
      <Stack gap={3}>
        <p>{t("dsv.customerNotice.withdrawnOn", { date: formatDate(notice.dueSince) })}</p>
        {notice.notifiedOn === null ? (
          <p>{t("dsv.customerNotice.due")}</p>
        ) : (
          <p>{t("dsv.customerNotice.notifiedOn", { date: formatDate(notice.notifiedOn) })}</p>
        )}
        {view.capabilities.recordCustomerNotice && (
          <div>
            <Button kind="tertiary" onClick={() => setOpen(true)}>
              {t("dsv.customerNotice.record")}
            </Button>
          </div>
        )}
      </Stack>
      <SidePanel
        open={open}
        title={t("dsv.customerNotice.record")}
        dirty={value !== ""}
        onClose={close}
        pendingNavigation={navigation}
      >
        {open && (
          <Stack gap={4}>
            {error && (
              <InlineNotification
                kind="error"
                title={t(`dsv.customerNotice.errors.${error as "failed"}`)}
                lowContrast
              />
            )}
            <p>{t("dsv.customerNotice.hint")}</p>
            <DateField
              id="dsv-customer-notified"
              labelText={t("dsv.customerNotice.date")}
              onChange={setValue}
            />
            <ActionButton
              disabled={busy}
              unavailableReason={!parsed.ok || !parsed.value ? t("dsv.contract.complete") : null}
              onClick={() => void save()}
            >
              {t("dsv.scans.save")}
            </ActionButton>
          </Stack>
        )}
      </SidePanel>
    </Card>
  );
}
