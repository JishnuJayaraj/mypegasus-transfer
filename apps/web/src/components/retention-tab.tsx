import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  ActionButton,
  Button,
  Card,
  Checkbox,
  InlineNotification,
  Loading,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  SidePanel,
  SimpleTable,
  Stack,
  TextInput,
  formatDate,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { fundingQuery, legalHoldsQuery, useApi } from "../api";
import { usePanelNavigationGuard } from "./panel-guard";

type Funded110 = components["schemas"]["Funded110"];
type HoldableClass = components["schemas"]["HoldableClass"];
type HoldRecordKind = components["schemas"]["HoldRecordKind"];
type Reason = components["schemas"]["LegalHoldReason"];
type Hold = components["schemas"]["LegalHoldItem"];

const fundings: Funded110[] = ["known_yes", "known_no", "unknown"];
const holdableClasses: HoldableClass[] = [
  "personnel_file",
  "health_record",
  "form_working_copy",
  "evidence_set",
];
const recordKinds: HoldRecordKind[] = [
  "dsv_offer",
  "dsv_contract",
  "dsv_scan_signature",
  "participant_reminder",
  "appointment_booking",
  "consent_record",
  "participant_channel",
  "participant_details",
  "participant_profile",
  "participant_profiling",
  "participant_profiling_assessment",
  "participant_health_data",
  "participant_profiling_health_assessment",
];
const reasons: Reason[] = [
  "litigation",
  "authority_request",
  "documented_dispute",
  "dpo_instruction",
];
const valid = (text: string) =>
  text.length >= 1 && text.length <= 200 && text === text.trim() && !/\p{Cc}/u.test(text);
const toggle = <T,>(list: T[], item: T, on: boolean) =>
  on ? [...list, item] : list.filter((x) => x !== item);
const codeOf = (problem: unknown) =>
  problem instanceof ApiProblemError ? problem.problem.errors?.[0]?.code : undefined;

/**
 * The tab "Aufbewahrung" (the PL and back office; data-protection.md, funding and legal holds):
 * "Förderung", the §110 funding back office records with its documented source, and
 * "Aufbewahrungssperren", the legal holds on selected records or classes, never the whole
 * participation; a hold is released by the region's operations manager in "Freigaben".
 */
export function RetentionTab({ participationId }: { participationId: string }) {
  return (
    <Stack gap={6}>
      <FundingCard participationId={participationId} />
      <LegalHoldsCard participationId={participationId} />
    </Stack>
  );
}

function FundingCard({ participationId }: { participationId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const cache = useQueryClient();
  const options = fundingQuery(api, participationId);
  const query = useQuery(options);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<Funded110 | null>(null);
  const [source, setSource] = useState("");
  const [expected, setExpected] = useState<{ funded110: Funded110; source: string | null }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = open && (value !== null || source !== "");
  const navigation = usePanelNavigationGuard(dirty);

  const body = () => {
    if (query.isPending) return <Loading label={t("retention.funding.loading")} />;
    if (query.isError) return <p>{t("retention.funding.failed")}</p>;
    const view = query.data;
    return (
      <Stack gap={4}>
        <dl className="tp-facts">
          <div>
            <dt>{t("retention.funding.value")}</dt>
            <dd>{t(`retention.funding.values.${view.funded110}`)}</dd>
          </div>
          {view.source !== null && (
            <div>
              <dt>{t("retention.funding.source")}</dt>
              <dd>{view.source}</dd>
            </div>
          )}
        </dl>
        <p>{t("retention.funding.hint")}</p>
        {view.capabilities.set && (
          <div>
            <Button
              kind="tertiary"
              onClick={() => {
                setExpected({ funded110: view.funded110, source: view.source });
                setValue(null);
                setSource("");
                setError(null);
                setOpen(true);
              }}
            >
              {t("retention.funding.edit")}
            </Button>
          </div>
        )}
      </Stack>
    );
  };

  async function save() {
    if (!value || !valid(source) || !expected) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.PUT("/api/v1/participations/{participationId}/funding", {
        params: { path: { participationId } },
        body: { funded110: value, source, expected },
      });
      if (result.error) setError("failed");
      else setOpen(false);
    } catch (problem) {
      const code = codeOf(problem);
      setError(code === "stale_funding" || code === "funding_unchanged" ? code : "failed");
    } finally {
      setBusy(false);
      await cache.invalidateQueries({ queryKey: options.queryKey });
    }
  }

  return (
    <Card title={t("retention.funding.title")} level={3}>
      {body()}
      <SidePanel
        open={open}
        title={t("retention.funding.edit")}
        dirty={dirty}
        onClose={() => setOpen(false)}
        pendingNavigation={navigation}
      >
        {open && (
          <Stack gap={4}>
            {error && (
              <InlineNotification
                kind="error"
                role="alert"
                title={t(`retention.funding.errors.${error as "failed"}`)}
                lowContrast
              />
            )}
            <RadioButtonGroup
              legendText={t("retention.funding.value")}
              name="funding-value"
              orientation="vertical"
              valueSelected={value ?? ""}
              onChange={(next) => setValue(next as Funded110)}
            >
              {fundings.map((f) => (
                <RadioButton
                  key={f}
                  id={`funding-${f}`}
                  value={f}
                  labelText={t(`retention.funding.values.${f}`)}
                />
              ))}
            </RadioButtonGroup>
            <TextInput
              id="funding-source"
              labelText={t("retention.funding.source")}
              helperText={t("retention.funding.sourceHelp")}
              maxLength={200}
              value={source}
              onChange={(event) => setSource(event.target.value)}
            />
            <ActionButton
              disabled={busy}
              unavailableReason={
                value === null || !valid(source) ? t("retention.funding.incomplete") : null
              }
              onClick={() => void save()}
            >
              {t("retention.save")}
            </ActionButton>
          </Stack>
        )}
      </SidePanel>
    </Card>
  );
}

function scopeText(t: (key: string, options?: { count: number }) => string, hold: Hold): string {
  return [
    ...hold.classes.map((c) => t(`retention.classes.${c}`)),
    ...hold.recordKinds.map((k) => t(`retention.kinds.${k}`)),
    ...(hold.documentIds.length > 0
      ? [t("retention.holds.documents", { count: hold.documentIds.length })]
      : []),
  ].join(", ");
}

function LegalHoldsCard({ participationId }: { participationId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const cache = useQueryClient();
  const options = legalHoldsQuery(api, participationId);
  const query = useQuery(options);
  const [open, setOpen] = useState(false);
  const [classes, setClasses] = useState<HoldableClass[]>([]);
  const [kinds, setKinds] = useState<HoldRecordKind[]>([]);
  const [reason, setReason] = useState<Reason | "">("");
  const [basis, setBasis] = useState("");
  const [expected, setExpected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = open && (classes.length + kinds.length > 0 || reason !== "" || basis !== "");
  const navigation = usePanelNavigationGuard(dirty);

  async function save() {
    if (reason === "" || !valid(basis)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.POST("/api/v1/participations/{participationId}/legal-holds", {
        params: { path: { participationId } },
        body: {
          classes,
          recordKinds: kinds,
          documentIds: [],
          reason,
          basis,
          expected: { activeHoldIds: expected },
        },
      });
      if (result.error) setError("failed");
      else setOpen(false);
    } catch (problem) {
      const code = codeOf(problem);
      setError(
        code === "stale_holds" || code === "hold_scope_empty" || code === "hold_scope_too_broad"
          ? code
          : "failed",
      );
    } finally {
      setBusy(false);
      await cache.invalidateQueries({ queryKey: options.queryKey });
    }
  }

  const body = () => {
    if (query.isPending) return <Loading label={t("retention.holds.loading")} />;
    if (query.isError) return <p>{t("retention.holds.failed")}</p>;
    const view = query.data;
    return (
      <Stack gap={4}>
        {view.evidenceSetSince !== null && (
          <p>
            <strong>{t("retention.evidenceOnly")}</strong>
          </p>
        )}
        {view.holds.length === 0 ? (
          <p>{t("retention.holds.none")}</p>
        ) : (
          <SimpleTable
            title={t("retention.holds.title")}
            hideTitle
            emptyState={t("retention.holds.none")}
            columns={[
              { key: "scope", header: t("retention.holds.scope") },
              { key: "reason", header: t("retention.holds.reason") },
              { key: "basis", header: t("retention.holds.basis") },
              { key: "placed", header: t("retention.holds.placedOn") },
              { key: "state", header: t("retention.holds.state") },
            ]}
            rows={view.holds.map((hold) => ({
              id: hold.id,
              scope: scopeText(t as (key: string, options?: { count: number }) => string, hold),
              reason: t(`retention.reasons.${hold.reason}`),
              basis: hold.basis ?? "",
              placed: formatDate(hold.placedOn),
              state:
                hold.releasedOn === null
                  ? t("retention.holds.active")
                  : t("retention.holds.releasedOn", { date: formatDate(hold.releasedOn) }),
            }))}
          />
        )}
        <p>{t("retention.holds.hint")}</p>
        {view.capabilities.place && (
          <div>
            <Button
              kind="tertiary"
              onClick={() => {
                setExpected(
                  view.holds
                    .filter((h) => h.releasedOn === null)
                    .map((h) => h.id)
                    .toSorted(),
                );
                setClasses([]);
                setKinds([]);
                setReason("");
                setBasis("");
                setError(null);
                setOpen(true);
              }}
            >
              {t("retention.holds.place")}
            </Button>
          </div>
        )}
      </Stack>
    );
  };

  const empty = classes.length + kinds.length === 0;
  const tooBroad = holdableClasses.every((c) => classes.includes(c));
  return (
    <Card title={t("retention.holds.title")} level={3}>
      {body()}
      <SidePanel
        open={open}
        title={t("retention.holds.place")}
        dirty={dirty}
        onClose={() => setOpen(false)}
        pendingNavigation={navigation}
      >
        {open && (
          <Stack gap={5}>
            {error && (
              <InlineNotification
                kind="error"
                role="alert"
                title={t(`retention.holds.errors.${error as "failed"}`)}
                lowContrast
              />
            )}
            <p>{t("retention.holds.scopeHint")}</p>
            <fieldset className="cds--fieldset">
              <legend className="cds--label">{t("retention.holds.classes")}</legend>
              {holdableClasses.map((c) => (
                <Checkbox
                  key={c}
                  id={`hold-class-${c}`}
                  labelText={t(`retention.classes.${c}`)}
                  checked={classes.includes(c)}
                  onChange={(_, { checked }) => setClasses((list) => toggle(list, c, checked))}
                />
              ))}
            </fieldset>
            <fieldset className="cds--fieldset">
              <legend className="cds--label">{t("retention.holds.records")}</legend>
              {recordKinds.map((k) => (
                <Checkbox
                  key={k}
                  id={`hold-kind-${k}`}
                  labelText={t(`retention.kinds.${k}`)}
                  checked={kinds.includes(k)}
                  onChange={(_, { checked }) => setKinds((list) => toggle(list, k, checked))}
                />
              ))}
            </fieldset>
            <Select
              id="hold-reason"
              labelText={t("retention.holds.reason")}
              value={reason}
              onChange={(event) => setReason(event.target.value as Reason | "")}
            >
              <SelectItem value="" text={t("retention.holds.choose")} />
              {reasons.map((r) => (
                <SelectItem key={r} value={r} text={t(`retention.reasons.${r}`)} />
              ))}
            </Select>
            <TextInput
              id="hold-basis"
              labelText={t("retention.holds.basis")}
              helperText={t("retention.holds.basisHelp")}
              maxLength={200}
              value={basis}
              onChange={(event) => setBasis(event.target.value)}
            />
            <ActionButton
              disabled={busy}
              unavailableReason={
                empty
                  ? t("retention.holds.errors.hold_scope_empty")
                  : tooBroad
                    ? t("retention.holds.errors.hold_scope_too_broad")
                    : reason === "" || !valid(basis)
                      ? t("retention.holds.incomplete")
                      : null
              }
              onClick={() => void save()}
            >
              {t("retention.holds.place")}
            </ActionButton>
          </Stack>
        )}
      </SidePanel>
    </Card>
  );
}
