import { useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import { endReasonsForPhase, type EndReason } from "@transfer/domain";
import {
  ActionButton,
  Checkbox,
  DateField,
  InlineNotification,
  Select,
  SelectItem,
  SidePanel,
  Stack,
  formatDate,
  parseDisplayDate,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "../api";
import { usePanelNavigationGuard } from "./panel-guard";

type Detail = components["schemas"]["ParticipationDetail"];

/** The refusal codes a dialog explains; anything else is a generic failure. */
const known = new Set([
  "withdrawal_after_dsv_signed",
  "effective_date_before_cancellation",
  "effective_date_in_future",
  "after_planned_start",
  "dsv_cancellation_missing",
  "tg_start_missing",
  "reason_unchanged",
  "reason_wrong_phase",
  "stale",
]);

function refusalOf(problem: unknown): string {
  if (!(problem instanceof ApiProblemError)) return "failed";
  if (problem.status === 409) return "stale";
  const code = problem.problem.errors?.[0]?.code;
  return code && known.has(code) ? code : "failed";
}

/** Whether "Zurückziehen" is offered: open now, or blocked by a prerequisite the PL can meet. */
export function withdrawOffered(detail: Detail): boolean {
  const refusal = detail.refusals.withdraw;
  return (
    detail.capabilities.withdraw ||
    refusal === "dsv_cancellation_missing" ||
    refusal === "after_planned_start" ||
    refusal === "tg_start_missing"
  );
}

/**
 * "Zurückziehen" (process-and-lifecycle.md, manual withdrawal; the cancellation for a signed DSV,
 * Q46 verify): a pre-TG reason and the effective date, nothing preset; the status version read when
 * the dialog opened; for a signed DSV the cancellation's validity and the PL's confirmation. A
 * blocked withdrawal shows its prerequisite and no save.
 */
export function WithdrawDialog({ detail, onClose }: { detail: Detail; onClose: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const cache = useQueryClient();
  // The dialog captures the version it was opened on (ui-patterns.md, C4).
  const [version] = useState(detail.statusVersion);
  const [reason, setReason] = useState("");
  const [date, setDate] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = reason !== "" || date !== "" || confirmed;
  const navigation = usePanelNavigationGuard(dirty);
  const signed = detail.dsvStatus === "dsv_signed";
  const parsed = parseDisplayDate(date);
  const blocked = detail.capabilities.withdraw ? null : detail.refusals.withdraw;
  const incomplete = reason === "" || !parsed.ok || !parsed.value || (signed && !confirmed);
  async function save() {
    if (!parsed.ok || !parsed.value) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.POST("/api/v1/participations/{participationId}/withdrawal", {
        params: { path: { participationId: detail.id } },
        body: {
          endReason: reason as EndReason,
          effectiveDate: parsed.value,
          statusVersion: version,
          ...(signed && { confirmed }),
        },
      });
      if (result.error) setError("failed");
      else onClose();
    } catch (problem) {
      setError(refusalOf(problem));
    } finally {
      setBusy(false);
      await cache.invalidateQueries({ queryKey: ["participations", detail.id] });
      await cache.invalidateQueries({ queryKey: ["projects", detail.projectId] });
    }
  }
  return (
    <SidePanel
      open
      title={t("participant.withdrawal.title")}
      dirty={dirty}
      onClose={onClose}
      pendingNavigation={navigation}
    >
      <Stack gap={4}>
        {blocked && (
          <InlineNotification
            kind="info"
            title={t(`participant.withdrawal.refusals.${blocked as "after_planned_start"}`)}
            hideCloseButton
            lowContrast
          />
        )}
        {error && (
          <InlineNotification
            kind="error"
            title={t(`participant.withdrawal.errors.${error as "failed"}`)}
            lowContrast
          />
        )}
        <p>{t("participant.withdrawal.hint")}</p>
        <Select
          id="withdrawal-reason"
          labelText={t("participant.withdrawal.reason")}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        >
          <SelectItem value="" text={t("dsv.scans.choose")} />
          {endReasonsForPhase("pre_tg").map((code) => (
            <SelectItem key={code} value={code} text={t(`history.reasons.${code as "other"}`)} />
          ))}
        </Select>
        <DateField
          id="withdrawal-date"
          labelText={t("participant.withdrawal.date")}
          onChange={setDate}
        />
        {signed && (
          <>
            <p>
              {detail.dsvCancellationValidOn
                ? t("participant.withdrawal.cancellation", {
                    date: formatDate(detail.dsvCancellationValidOn),
                  })
                : t("participant.withdrawal.noCancellation")}
            </p>
            <Checkbox
              id="withdrawal-confirmed"
              labelText={t("participant.withdrawal.confirm")}
              checked={confirmed}
              onChange={(_, data) => setConfirmed(data.checked)}
            />
          </>
        )}
        {!blocked && (
          <ActionButton
            kind="danger"
            disabled={busy}
            unavailableReason={incomplete ? t("participant.withdrawal.complete") : null}
            onClick={() => void save()}
          >
            {t("participant.withdrawal.save")}
          </ActionButton>
        )}
      </Stack>
    </SidePanel>
  );
}

/**
 * "Grund korrigieren" (Q72): the primary end reason against the one read, in its phase; a
 * system-derived reason moves to the secondary list, the PL's earlier reason only when the PL
 * confirms it still applies. The terminal status stays.
 */
export function EndReasonDialog({ detail, onClose }: { detail: Detail; onClose: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const cache = useQueryClient();
  const [expected] = useState(detail.endReason!);
  const [reason, setReason] = useState("");
  const [stillApplies, setStillApplies] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = reason !== "" || stillApplies;
  const navigation = usePanelNavigationGuard(dirty);
  const phase = detail.status === "exited" ? "tg" : "pre_tg";
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.PUT("/api/v1/participations/{participationId}/end-reason", {
        params: { path: { participationId: detail.id } },
        body: {
          endReason: reason as EndReason,
          expected,
          ...(detail.endReasonSource === "user" && { previousStillApplies: stillApplies }),
        },
      });
      if (result.error) setError("failed");
      else onClose();
    } catch (problem) {
      setError(refusalOf(problem));
    } finally {
      setBusy(false);
      await cache.invalidateQueries({ queryKey: ["participations", detail.id] });
    }
  }
  return (
    <SidePanel
      open
      title={t("participant.endReason.title")}
      dirty={dirty}
      onClose={onClose}
      pendingNavigation={navigation}
    >
      <Stack gap={4}>
        {error && (
          <InlineNotification
            kind="error"
            title={t(`participant.withdrawal.errors.${error as "failed"}`)}
            lowContrast
          />
        )}
        <p>
          {t(
            detail.endReasonSource === "system"
              ? "participant.endReason.currentSystem"
              : "participant.endReason.current",
            { reason: t(`history.reasons.${expected as "other"}`) },
          )}
        </p>
        <Select
          id="end-reason"
          labelText={t("participant.endReason.reason")}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        >
          <SelectItem value="" text={t("dsv.scans.choose")} />
          {endReasonsForPhase(phase)
            .filter((code) => code !== "long_term_illness_reduced_earning_capacity")
            .map((code) => (
              <SelectItem key={code} value={code} text={t(`history.reasons.${code as "other"}`)} />
            ))}
        </Select>
        {detail.endReasonSource === "user" && (
          <Checkbox
            id="end-reason-still-applies"
            labelText={t("participant.endReason.stillApplies")}
            checked={stillApplies}
            onChange={(_, data) => setStillApplies(data.checked)}
          />
        )}
        <ActionButton
          disabled={busy}
          unavailableReason={reason === "" ? t("participant.withdrawal.complete") : null}
          onClick={() => void save()}
        >
          {t("participant.endReason.save")}
        </ActionButton>
      </Stack>
    </SidePanel>
  );
}
