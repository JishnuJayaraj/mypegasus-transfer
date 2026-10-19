import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, createLink, type ErrorComponentProps } from "@tanstack/react-router";
import { ApiProblemError, type components } from "@transfer/api-client";
import { formatDate, InlineNotification, Link, PageHeader } from "@transfer/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { entryWavesQuery, participationQuery, projectQuery, useApi } from "../../api";
import { EntryWaveChoice } from "../../components/entry-wave-choice";
import { RouteError } from "../../components/route-error";
import type de from "../../locales/de/translation.json";

type Detail = components["schemas"]["ParticipationDetail"];
type FieldKey = keyof typeof de.participant.fields;
const RouterLink = createLink(Link);

export const Route = createFileRoute("/projects/$projectId_/participations/$participationId")({
  loader: async ({ context: { api, queryClient }, params: { projectId, participationId } }) => {
    const [project, detail] = await Promise.all([
      queryClient.ensureQueryData(projectQuery(api, projectId)),
      queryClient.ensureQueryData(participationQuery(api, participationId)),
    ]);
    // The participant must belong to the project in the URL; anything else is not found, and
    // nothing of the other project (its waves) is loaded (review of PR 2h-1).
    if (detail.projectId !== projectId) {
      throw new ApiProblemError({
        type: "urn:transfer:problem:not-found",
        title: "Not found",
        status: 404,
      });
    }
    // The wave choice lists the project's waves (visible to every member).
    if (project.type === "ta_tg")
      await queryClient.ensureQueryData(entryWavesQuery(api, projectId));
  },
  component: ParticipationPage,
  errorComponent: ParticipationError,
});

/** A 403 or 404 reads as "not allowed" or "not found", never as an empty page. */
function ParticipationError(props: ErrorComponentProps) {
  const { t } = useTranslation();
  const { error } = props;
  if (error instanceof ApiProblemError && [403, 404].includes(error.status)) {
    const key = error.status === 403 ? "participant.forbidden" : "participant.notFound";
    return <InlineNotification kind="error" title={t(key)} hideCloseButton />;
  }
  return <RouteError {...props} />;
}

/**
 * One participant (Slice 2 plan, "Planned in PR 2h"; 5.13): person, contact, status, wave and
 * contractual dates. The API sends only what the viewer may read: an absent field isn't shown, a
 * field without a value shows a dash. Only the PL gets actions, as the API's capabilities say.
 */
function ParticipationPage() {
  const { t } = useTranslation();
  const { projectId, participationId } = Route.useParams();
  const api = useApi();
  const { data: project } = useSuspenseQuery(projectQuery(api, projectId));
  const { data: detail } = useSuspenseQuery(participationQuery(api, participationId));
  // The loader refuses a participant of another project; the cache can't change that later.
  if (detail.projectId !== projectId) {
    return <InlineNotification kind="error" title={t("participant.notFound")} hideCloseButton />;
  }
  const { person, dates } = detail;
  const name = [person.lastName, person.firstName].filter(Boolean).join(", ");
  return (
    <>
      <RouterLink to="/projects/$projectId" params={{ projectId }}>
        {t("participant.back", { project: project.name })}
      </RouterLink>
      <PageHeader title={name || t("participant.title")} />
      {detail.hints.map((hint) => (
        <InlineNotification
          key={hint}
          kind="warning"
          title={t(`participant.hints.${hint}`)}
          hideCloseButton
        />
      ))}
      <Facts
        title={t("participant.person")}
        rows={[
          ["personnelNumber", person.personnelNumber],
          ["lastName", person.lastName],
          ["firstName", person.firstName],
          ["birthDate", date(person.birthDate)],
          ["oldEmploymentEndDate", date(person.oldEmploymentEndDate)],
        ]}
      />
      <Facts
        title={t("participant.contact")}
        rows={[
          ["address", address(person.address)],
          ["phone", person.phone],
          ["mobile", person.mobile],
          ["privateEmail", person.privateEmail],
          ["workEmail", person.workEmail],
        ]}
      />
      {person.workEmail !== undefined && <p>{t("participant.workEmailHint")}</p>}
      <Facts
        title={t("participant.status")}
        rows={[
          ["status", t(`participants.statuses.${detail.status}`)],
          ["profilingStatus", t(`participants.profilingStatuses.${detail.profilingStatus}`)],
          ["dsvStatus", t(`participants.dsvStatuses.${detail.dsvStatus}`)],
          ["tgEntryDate", date(dates.tgEntryDate)],
          ["exitDate", date(dates.exitDate)],
          ["withdrawnOn", date(dates.withdrawnOn)],
        ]}
      />
      {project.type === "ta_tg" && <WaveAndDates detail={detail} projectId={projectId} />}
    </>
  );
}

const date = (value: string | null | undefined) =>
  value === undefined ? undefined : formatDate(value);
const address = (value: Detail["person"]["address"]) =>
  value && `${value.street}, ${value.postalCode} ${value.city}, ${value.country}`;

function WaveAndDates({ detail, projectId }: { detail: Detail; projectId: string }) {
  const { t } = useTranslation();
  const { entryWave: wave, dates } = detail;
  // Where a contractual date comes from: the participation's own, else the wave's (5.7).
  const source = (own: string | null, effective: string | null) =>
    effective === null
      ? null
      : `${formatDate(effective)} (${t(own === null ? "participant.fromWave" : "participant.individual")})`;
  return (
    <>
      <Facts
        title={t("participant.waveAndDates")}
        rows={[
          ["wave", wave ? `${wave.code} – ${wave.name}` : null],
          // The wave's own four dates, also where individual dates override them (5.13).
          ["signingDeadline", wave && formatDate(wave.signingDeadline)],
          ["defaultTgStart", wave && formatDate(wave.defaultTgStart)],
          ["defaultTgEnd", wave && formatDate(wave.defaultTgEnd)],
          ["latestEntryDate", wave && formatDate(wave.latestEntryDate)],
          ["offerDeadline", date(dates.offerDeadline)],
          ["tgStart", source(dates.tgStart, dates.effectiveTgStart)],
          ["tgEnd", source(dates.tgEnd, dates.effectiveTgEnd)],
        ]}
      />
      <EntryWaveChoice detail={detail} projectId={projectId} />
    </>
  );
}

/** A titled list of label/value pairs; `undefined` (not readable) hides the row. */
function Facts({ title, rows }: { title: string; rows: [FieldKey, ReactNode][] }) {
  const { t } = useTranslation();
  const shown = rows.filter(([, value]) => value !== undefined);
  if (shown.length === 0) return null;
  return (
    <section className="tp-section" aria-label={title}>
      <h2>{title}</h2>
      <dl className="tp-facts">
        {shown.map(([key, value]) => (
          <div key={key}>
            <dt>{t(`participant.fields.${key}`)}</dt>
            <dd>{value === null || value === "" ? "—" : value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
