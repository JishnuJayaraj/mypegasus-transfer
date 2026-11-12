import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, createLink } from "@tanstack/react-router";
import { Add, Button, Card, formatDate, Link, SimpleTable, useToast } from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { entryWavesQuery, projectConfigQuery, useApi } from "../../../api";
import { AgenturSettings } from "../../../components/agentur-settings";
import { DsvTemplateCard } from "../../../components/dsv-template";
import { EntryWaveForm } from "../../../components/entry-wave-form";
import { ImportSection } from "../../../components/import-section";
import { Kug200aHeader } from "../../../components/kug200a-header";
import { ProjectRegion } from "../../../components/project-region";
import { ProjectSectionPage } from "../../../components/project-sections";
import { ProjectSetup } from "../../../components/project-setup";
import { SettlementDatesCard } from "../../../components/settlement-dates";

const RouterLink = createLink(Link);

export const Route = createFileRoute("/projects/$projectId/setup")({ component: Setup });

function Setup() {
  const { projectId } = Route.useParams();
  return (
    <ProjectSectionPage section="setup" projectId={projectId}>
      {(taTg) => <ProjectSetupTab projectId={projectId} taTg={taTg} />}
    </ProjectSectionPage>
  );
}

/**
 * "Einrichtung" as cards (ui-patterns.md, setup pages): Projekt (status, region change, blockers,
 * activation), Agentur (pins and Agentur-specific settings), Wellen (in `ta_only` only why there
 * are none), Kug 200a-Kopf and DSV-Vorlage (`ta_tg`), Import (`project-import`, the target of "Datei importieren") and Abrechnung (`ta_tg`). An anchor list beside them on
 * wide screens; below 66rem the cards simply follow each other.
 */
function ProjectSetupTab({ projectId, taTg }: { projectId: string; taTg: boolean }) {
  const { t } = useTranslation();
  const anchors = [
    { id: "setup-project", label: t("setup.project") },
    { id: "setup-agentur", label: t("setup.agenturTitle") },
    { id: "setup-waves", label: t("projectDetail.waves") },
    ...(taTg
      ? [
          { id: "setup-kug200a", label: t("kug200aHeader.title") },
          { id: "setup-dsv", label: t("dsvTemplate.title") },
        ]
      : []),
    { id: "project-import", label: t("import.title") },
    ...(taTg ? [{ id: "setup-settlement", label: t("settlement.title") }] : []),
  ];
  return (
    <div className="tp-anchored">
      <nav className="tp-anchor-list" aria-label={t("setup.onThisPage")}>
        <p className="tp-anchor-list-title" aria-hidden="true">
          {t("setup.onThisPage")}
        </p>
        <ul>
          {anchors.map(({ id, label }) => (
            <li key={id}>
              <RouterLink to="/projects/$projectId/setup" params={{ projectId }} hash={id}>
                {label}
              </RouterLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="tp-anchored-content">
        <ProjectSetup
          projectId={projectId}
          region={<ProjectRegion projectId={projectId} />}
          agentur={<AgenturSettings projectId={projectId} />}
        />
        {taTg ? (
          <>
            <EntryWaves projectId={projectId} />
            <Kug200aHeader projectId={projectId} />
            <DsvTemplateCard projectId={projectId} />
          </>
        ) : (
          <Card id="setup-waves" title={t("projectDetail.waves")}>
            <p>{t("waveForm.errors.not_ta_tg")}</p>
          </Card>
        )}
        <ImportSection projectId={projectId} />
        {/* Last: it loads after the anchors' targets above it ("Datei importieren"). */}
        {taTg && <SettlementDatesCard projectId={projectId} />}
      </div>
    </div>
  );
}

const columns = [
  "code",
  "name",
  "signingDeadline",
  "defaultTgStart",
  "defaultTgEnd",
  "latestEntryDate",
  "participations",
  "actions",
] as const;

/** The waves (Eintrittswellen) and one form for a new or the chosen wave. */
function EntryWaves({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const api = useApi();
  const query = entryWavesQuery(api, projectId);
  const { data: waves } = useSuspenseQuery(query);
  // "new", a wave's id, or no form.
  const [editing, setEditing] = useState<string | null>(null);

  const rows = waves.map((wave) => ({
    id: wave.id,
    code: wave.code,
    name: wave.name,
    signingDeadline: formatDate(wave.signingDeadline),
    defaultTgStart: formatDate(wave.defaultTgStart),
    defaultTgEnd: formatDate(wave.defaultTgEnd),
    latestEntryDate: formatDate(wave.latestEntryDate),
    participations: String(wave.participations),
    actions: (
      <Button kind="ghost" size="sm" onClick={() => setEditing(wave.id)}>
        {t("projectDetail.edit", { code: wave.code })}
      </Button>
    ),
  }));

  return (
    <Card id="setup-waves" title={t("projectDetail.waves")}>
      <SimpleTable
        title={t("projectDetail.waves")}
        hideTitle
        columns={columns.map((key) => ({ key, header: t(`projectDetail.columns.${key}`) }))}
        rows={rows}
        emptyState={t("projectDetail.wavesEmpty")}
        footer={
          editing === null && (
            <Button renderIcon={Add} onClick={() => setEditing("new")}>
              {t("projectDetail.addWave")}
            </Button>
          )
        }
      />
      {editing !== null && (
        <EntryWaveForm
          key={editing}
          projectId={projectId}
          wave={waves.find((wave) => wave.id === editing)}
          onCancel={() => setEditing(null)}
          onSaved={async (wave) => {
            // A wave's latest entry date changes the activation blockers (Q77).
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: query.queryKey }),
              queryClient.invalidateQueries({
                queryKey: projectConfigQuery(api, projectId).queryKey,
              }),
            ]);
            showToast({ title: t("projectDetail.waveSaved"), subtitle: wave.code });
            setEditing(null);
          }}
        />
      )}
    </Card>
  );
}
