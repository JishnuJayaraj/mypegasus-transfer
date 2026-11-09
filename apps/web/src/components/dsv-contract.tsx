import { useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  ActionButton,
  Button,
  Card,
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

type View = components["schemas"]["DsvView"];
type Contract = NonNullable<View["contract"]>;
type Field = "originalLocation" | "originalReceivedOn" | "sentToCustomerOn";
const originalFields = ["originalLocation", "originalReceivedOn", "sentToCustomerOn"] as const;
const signatureFields = [
  ["participant", "participantSignedOn"],
  ["customer", "customerSignedOn"],
  ["transfergesellschaft", "tgSignedOn"],
] as const;

/**
 * The signed contract (process-and-lifecycle.md, DSV packet and original): who signed on which
 * actual date, when the contract counts as fully executed, and the original's tracking. The
 * original is changed against the value shown (`409 stale_value`); it is never a guard.
 */
export function DsvContract({ view }: { view: View }) {
  const { t } = useTranslation();
  const api = useApi();
  const cache = useQueryClient();
  const contract: Contract | null = view.contract;
  // The dialog captures the field and the value it was opened on (ui-patterns.md, C4).
  const [target, setTarget] = useState<{ field: Field; expected: string | null } | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"failed" | "stale" | null>(null);
  const dirty = value !== "";
  const navigation = usePanelNavigationGuard(target !== null && dirty);
  const close = () => {
    setTarget(null);
    setValue("");
    setError(null);
  };
  const parsed = parseDisplayDate(value);
  const invalid = target?.field !== "originalLocation" && !parsed.ok;
  async function save() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const body =
        target.field === "originalLocation"
          ? ({
              field: "originalLocation",
              value: "paper_personnel_file",
              expected: target.expected as "paper_personnel_file" | null,
            } as const)
          : ({
              field: target.field,
              value: parsed.ok ? (parsed.value ?? "") : "",
              expected: target.expected,
            } as const);
      const result = await api.PUT(
        "/api/v1/participations/{participationId}/dsv/contract/original",
        {
          params: { path: { participationId: view.participationId } },
          body,
        },
      );
      if (result.error) setError("failed");
      else close();
    } catch (problem) {
      // A changed value is a conflict (`stale_value`): the dialog keeps its input.
      setError(problem instanceof ApiProblemError && problem.status === 409 ? "stale" : "failed");
    } finally {
      setBusy(false);
      await cache.invalidateQueries({ queryKey: ["participations", view.participationId] });
    }
  }
  const executed = view.facts.dsvFullyExecuted;
  return (
    <Card title={t("dsv.contract.title")} level={3}>
      {contract === null ? (
        <p>{t("dsv.contract.none")}</p>
      ) : (
        <Stack gap={5}>
          <Stack gap={2}>
            <strong>{t("dsv.contract.signatures")}</strong>
            <dl className="tp-facts">
              {signatureFields.map(([kind, key]) => (
                <div key={kind}>
                  <dt>{t(`dsv.scans.${kind}`)}</dt>
                  <dd>{contract[key] ? formatDate(contract[key]!) : t("dsv.contract.pending")}</dd>
                </div>
              ))}
            </dl>
            <p>
              {executed
                ? t("dsv.contract.fullyExecuted", { date: formatDate(executed.validOn) })
                : t("dsv.contract.notFullyExecuted")}
            </p>
          </Stack>
          <Stack gap={2}>
            <strong>{t("dsv.contract.original")}</strong>
            <dl className="tp-facts">
              {originalFields.map((field) => {
                const current = contract[field];
                return (
                  <div key={field}>
                    <dt>{t(`dsv.contract.fields.${field}`)}</dt>
                    <dd>
                      {current === null
                        ? t("dsv.contract.notRecorded")
                        : field === "originalLocation"
                          ? t(`dsv.contract.locations.${current as "paper_personnel_file"}`)
                          : formatDate(current)}
                      {view.capabilities.recordOriginal && (
                        <div>
                          <Button
                            kind="ghost"
                            size="sm"
                            onClick={() => setTarget({ field, expected: current })}
                          >
                            {t(current === null ? "dsv.contract.record" : "dsv.contract.change")}
                            <span className="cds--visually-hidden">
                              {" "}
                              {t(`dsv.contract.fields.${field}`)}
                            </span>
                          </Button>
                        </div>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </Stack>
        </Stack>
      )}
      <SidePanel
        open={target !== null}
        title={target ? t(`dsv.contract.fields.${target.field}`) : ""}
        dirty={dirty}
        onClose={close}
        pendingNavigation={navigation}
      >
        {target && (
          <Stack gap={4}>
            {error && (
              <InlineNotification
                kind="error"
                title={t(error === "stale" ? "dsv.contract.stale" : "dsv.contract.failed")}
                lowContrast
              />
            )}
            {target.field === "originalLocation" ? (
              <Select
                id="dsv-original-location"
                labelText={t("dsv.contract.fields.originalLocation")}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              >
                <SelectItem value="" text={t("dsv.scans.choose")} />
                <SelectItem
                  value="paper_personnel_file"
                  text={t("dsv.contract.locations.paper_personnel_file")}
                />
              </Select>
            ) : (
              <DateField
                id="dsv-original-date"
                labelText={t(`dsv.contract.fields.${target.field}`)}
                onChange={setValue}
              />
            )}
            <ActionButton
              disabled={busy}
              unavailableReason={value === "" || invalid ? t("dsv.contract.complete") : null}
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
