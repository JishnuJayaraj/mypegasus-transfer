import { useQuery } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  SensitivePage,
  wizardPages,
  type SelfServicePage,
  type SensitiveField,
} from "@transfer/domain";
import { SELF_SERVICE_NAMESPACE } from "@transfer/self-service-ui";
import { Button, formatTimestamp, InlineNotification, Stack } from "@transfer/ui";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { participationSelfServiceQuery, useApi } from "../api";
import { StartAssistedMode } from "./assisted-mode";
import { formatSelfServiceValue } from "./self-service-values";

// The "Selbstauskunft" tab (data-protection.md, self-service; Q136): what the participant answered
// as the viewer may read it in normal mode, the highly confidential and special-category answers
// as "angegeben / fehlt" only, each "Anzeigen" a logged read of that one field for the roles the
// access matrix allows, and the missing items of the data-collection and profiling steps.

type View = components["schemas"]["ParticipationSelfService"];
type Detail = components["schemas"]["ParticipationDetail"];

export function SelfServiceTab({ detail, projectId }: { detail: Detail; projectId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const query = useQuery(participationSelfServiceQuery(api, detail.id));
  const start = detail.capabilities.startAssistedMode && (
    <StartAssistedMode projectId={projectId} participationId={detail.id} />
  );
  if (query.isPending) return <p>{t("participant.selfService.loading")}</p>;
  if (query.isError) {
    const forbidden = query.error instanceof ApiProblemError && query.error.status === 403;
    return (
      <Stack gap={5}>
        <InlineNotification
          kind={forbidden ? "info" : "error"}
          title={t(
            forbidden ? "participant.selfService.forbidden" : "participant.selfService.failed",
          )}
          hideCloseButton
          lowContrast
        />
        {start}
      </Stack>
    );
  }
  const view = query.data;
  return (
    <Stack gap={6}>
      {start && <div>{start}</div>}
      <dl className="tp-facts">
        <div>
          <dt>{t("participant.selfService.notice")}</dt>
          <dd>
            {view.notice.acknowledgedAt
              ? t("participant.selfService.noticeAcknowledged", {
                  at: formatTimestamp(view.notice.acknowledgedAt),
                })
              : t("participant.selfService.noticeOpen")}
          </dd>
        </div>
      </dl>
      <Missing view={view} />
      {wizardPages
        .filter(({ page }) => page !== "further")
        .map(({ page }) => (
          <PageFacts key={page} page={page} view={view} />
        ))}
      <CustomFacts view={view} />
    </Stack>
  );
}

/** The wizard's labels (its own namespace), for keys built at run time. */
function useWizardText() {
  const { t } = useTranslation(SELF_SERVICE_NAMESPACE);
  return (key: string): string => t(key as never);
}

/** A field's label: the wizard's, else the staff app's, else its key (a code). */
function useLabel() {
  const { t, i18n } = useTranslation();
  const wizardText = useWizardText();
  return (key: string): string => {
    const wizard = `fields.${key}.label`;
    if (i18n.exists(wizard, { ns: SELF_SERVICE_NAMESPACE })) return wizardText(wizard);
    const staff = `participant.fields.${key}`;
    return i18n.exists(staff) ? t(staff as never) : key;
  };
}

/** The missing items per step, as labels. */
function Missing({ view }: { view: View }) {
  const { t } = useTranslation();
  const label = useLabel();
  const steps = [...new Set(view.missing.map((item) => item.step))];
  return (
    <section className="tp-section" aria-label={t("participant.selfService.missing")}>
      <h2>{t("participant.selfService.missing")}</h2>
      {steps.length === 0 ? (
        <p>{t("participant.selfService.missingNone")}</p>
      ) : (
        steps.map((step) => (
          <div key={step}>
            <h3>{t(`relaxations.steps.${step}` as never)}</h3>
            <ul className="tp-list">
              {[...new Set(view.missing.filter((m) => m.step === step).map((m) => m.key))].map(
                (key) => (
                  <li key={key}>{label(key)}</li>
                ),
              )}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

/** One wizard page's answers; a page without a field the viewer may know about is left out. */
function PageFacts({ page, view }: { page: SelfServicePage; view: View }) {
  const { t } = useTranslation();
  const ts = useWizardText();
  const label = useLabel();
  const sensitive = SensitivePage.safeParse(page).success;
  const keys = (wizardPages.find((p) => p.page === page)?.fields ?? []).filter((key) =>
    sensitive ? key in view.sensitive : key in view.values,
  );
  if (keys.length === 0) return null;
  const title = ts(`pages.${page}`);
  const maintained = page === "contact" && view.participantMaintained.length > 0;
  return (
    <section className="tp-section" aria-label={title}>
      <h2>{title}</h2>
      {sensitive && <p className="tp-hint">{t("participant.selfService.showHint")}</p>}
      <dl className="tp-facts">
        {keys.map((key) => (
          <div key={key}>
            <dt>{label(key)}</dt>
            <dd>
              {sensitive ? (
                <SensitiveValue
                  view={view}
                  group={page as SensitivePage}
                  field={key as SensitiveField}
                />
              ) : (
                <Lines>
                  {formatSelfServiceValue(key, view.values[key as keyof View["values"]], ts)}
                </Lines>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {maintained && (
        <p className="tp-hint">
          {t("participant.selfService.maintained", {
            fields: view.participantMaintained.map(label).join(", "),
          })}
        </p>
      )}
    </section>
  );
}

/** "angegeben / fehlt"; "Anzeigen" reads the one field on its logged route, never cached. */
function SensitiveValue(props: { view: View; group: SensitivePage; field: SensitiveField }) {
  const { t } = useTranslation();
  const ts = useWizardText();
  const api = useApi();
  const label = useLabel();
  const { view, group, field } = props;
  const [shown, setShown] = useState<string>();
  const [failed, setFailed] = useState(false);
  const present = view.sensitive[field] === true;
  const readable = present && view.sensitiveReadable.includes(field);
  async function show() {
    setFailed(false);
    try {
      const { data } = await api.GET(
        "/api/v1/participations/{participationId}/self-service/sensitive/{group}",
        { params: { path: { participationId: view.participationId, group }, query: { field } } },
      );
      if (!data) throw new Error("No value");
      setShown(formatSelfServiceValue(field, data.values[field], ts));
    } catch {
      setFailed(true);
    }
  }
  if (shown !== undefined) return <Lines>{shown}</Lines>;
  return (
    <span className="tp-inline-actions">
      {t(present ? "participant.selfService.given" : "participant.selfService.absent")}
      {readable && (
        <Button
          kind="ghost"
          size="sm"
          onClick={() => void show()}
          aria-label={t("participant.selfService.showLabel", { field: label(field) })}
        >
          {t("participant.selfService.show")}
        </Button>
      )}
      {failed && <span className="tp-error">{t("participant.selfService.showFailed")}</span>}
    </span>
  );
}

/** The chain's custom fields the participant answered, by key. */
function CustomFacts({ view }: { view: View }) {
  const { t } = useTranslation();
  const entries = Object.entries(view.customValues);
  if (entries.length === 0) return null;
  return (
    <section className="tp-section" aria-label={t("participant.selfService.custom")}>
      <h2>{t("participant.selfService.custom")}</h2>
      <dl className="tp-facts">
        {entries.map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{value === null ? "—" : String(value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** A value of several lines (row tables), one per line. */
function Lines({ children }: { children: string }): ReactNode {
  const lines = children.split("\n");
  return lines.length === 1 ? children : lines.map((line) => <div key={line}>{line}</div>);
}
